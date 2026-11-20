// Local stand-in for the container's bevo-signer.mjs. DEV ONLY: never published
// by the hub (it lives outside scripts/). Same contract as production
// (docs/plans/architect-review-agent-keys.md section 3), plus the EXT fields:
//
//   export const isDev = true
//   mainSigner({ idempotencyKey })
//     -> { address, signTypedData(...) -> 0x, sendTransaction({chainId,to,data,value}) -> { hash|null, status } }
//   agentKey({ label, rotate, idempotencyKey, create /*EXT*/ })
//     -> { id, label, address, signerWallet, approved, generated, getAddress(), signTypedData(...),
//          toViemAccount(), markApproved(), pending } | null (create:false and no key)
//   signTypedData accepts (domain, types, value) AND ({ domain, types, primaryType, message }).
//
// Local signing never waits for an owner, so it never throws PendingOwnerAction
// and `pending` stays null. Every signature and transaction is idempotent per
// `${idempotencyKey}:${n}` (dev/.ledger.json), as bevo-server's ledger is: the same
// key with the same payload replays, with a different payload (a re-run's new nonce)
// it is refused IDEMPOTENCY_KEY_REUSED, so a re-run with an old key never bets twice.
//
// Keys come only from env vars or dev/.agent-key.json (gitignored). Nothing
// here ever prints a key.
//
// Env:
//   OUTCOME_MAIN_WALLET        main wallet address (required)
//   DEV_MAIN_PRIVATE_KEY       optional; without it deposit/approve cannot be signed locally
//   OUTCOME_AGENT_PRIVATE_KEY  optional; an already-approved agent key of the main wallet
//   ARBITRUM_RPC_URL           default https://arb1.arbitrum.io/rpc
//   DEV_SIGNER_LEDGER          ledger path override (tests); default dev/.ledger.json

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// dev/ has no node_modules of its own: resolve viem from the skill root install.
const requireFromRoot = createRequire(new URL("../package.json", import.meta.url));
const load = (spec) => import(pathToFileURL(requireFromRoot.resolve(spec)).href);
const { generatePrivateKey, privateKeyToAccount } = await load("viem/accounts");
const { createWalletClient, http, getAddress, hashTypedData } = await load("viem");
const { arbitrum } = await load("viem/chains");

export const isDev = true;

const KEY_FILE = fileURLToPath(new URL("./.agent-key.json", import.meta.url));
const LEDGER_FILE = process.env.DEV_SIGNER_LEDGER || fileURLToPath(new URL("./.ledger.json", import.meta.url));
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

function signerError(code, message, hint) {
  const err = new Error(message);
  err.code = code;
  err.hint = hint ?? null;
  return err;
}

/** Root type = the declared type no other type references (EIP712Domain excluded). */
function rootType(types) {
  const names = Object.keys(types).filter((n) => n !== "EIP712Domain");
  const referenced = new Set();
  for (const n of names) for (const f of types[n]) referenced.add(f.type.replace(/\[\d*\]$/, ""));
  const roots = names.filter((n) => !referenced.has(n));
  if (roots.length !== 1) throw signerError("BAD_TYPED_DATA", `typed data must have exactly one root type, found ${roots.length}`);
  return roots[0];
}

/** Accept hip4's (domain, types, value) and viem's ({domain, types, primaryType, message}). */
function normalizeTypedData(args) {
  let td;
  if (args.length >= 3) td = { domain: args[0], types: args[1], message: args[2] };
  else if (args.length === 1 && args[0] && typeof args[0] === "object") td = { ...args[0] };
  else throw signerError("BAD_TYPED_DATA", "signTypedData takes (domain, types, value) or one typed-data object");
  const { EIP712Domain: _ignored, ...types } = td.types ?? {};
  const primaryType = td.primaryType ?? rootType(types);
  const fields = types[primaryType];
  if (!fields) throw signerError("BAD_TYPED_DATA", `primaryType ${primaryType} is not declared`);
  const message = {};
  for (const f of fields) message[f.name] = td.message[f.name];
  return { domain: td.domain, types, primaryType, message };
}

function mainAddress() {
  const raw = process.env.OUTCOME_MAIN_WALLET;
  if (!raw) throw signerError("MAIN_WALLET_UNSET", "OUTCOME_MAIN_WALLET is not set.", "See dev/README.md.");
  try {
    return getAddress(raw.trim());
  } catch {
    throw signerError("MAIN_WALLET_UNSET", "OUTCOME_MAIN_WALLET is not a valid address.");
  }
}

function normalizeKey(pk) {
  const k = pk.trim();
  return k.startsWith("0x") ? k : `0x${k}`;
}

function mainAccount(address) {
  const pk = process.env.DEV_MAIN_PRIVATE_KEY;
  if (!pk) {
    throw signerError(
      "MAIN_SIGNER_UNAVAILABLE",
      "deposit/approve need the main wallet key; set DEV_MAIN_PRIVATE_KEY or test via bevo-server",
      "Export DEV_MAIN_PRIVATE_KEY for local tests, or run this step through bevo-server (L2).",
    );
  }
  const account = privateKeyToAccount(normalizeKey(pk));
  if (account.address.toLowerCase() !== address.toLowerCase()) {
    throw signerError("MAIN_SIGNER_MISMATCH", "DEV_MAIN_PRIVATE_KEY does not belong to OUTCOME_MAIN_WALLET.", "Fix the env vars; refusing to sign with the wrong wallet.");
  }
  return account;
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Per-call idempotency keys `${base}:${n}`, like the production signer. */
function keyCounter(base) {
  let n = 0;
  return () => (base ? `${base}:${++n}` : null);
}

const keyReused = (callKey) =>
  signerError(
    "IDEMPOTENCY_KEY_REUSED",
    `Idempotency key ${callKey.replace(/^agent_key\|/, "")} was already used for a different request.`,
    "This key already ran; read status/account before anything else."
  );

/** Mirrors bevo-signer's keyStatus over this signer's own ledger file. */
export async function keyStatus(key, { route = "execute" } = {}) {
  const ledger = readJson(LEDGER_FILE) ?? {};
  const stored = route === "agent_key" ? ledger[`agent_key|${key}`] : ledger[key];
  return { state: stored ? "executed" : "not_found" };
}

/** Sign once per call key: replay the stored signature, refuse a different payload. */
async function ledgeredSign(callKey, typedData, sign) {
  if (!callKey) return sign(typedData);
  const digest = hashTypedData(typedData);
  const ledger = readJson(LEDGER_FILE) ?? {};
  const prev = ledger[callKey];
  if (prev) {
    if (prev.digest !== digest) throw keyReused(callKey);
    return prev.signature;
  }
  const signature = await sign(typedData);
  writeJson(LEDGER_FILE, { ...ledger, [callKey]: { digest, signature, at: new Date().toISOString() } });
  return signature;
}

const HL_USER_SIGNED_PREFIX = "HyperliquidTransaction:";
const MAIN_MAY_SIGN = new Set([`${HL_USER_SIGNED_PREFIX}ApproveAgent`, `${HL_USER_SIGNED_PREFIX}Withdraw`]);

/** Mirror of the server rule: the main wallet signs only ApproveAgent and a Withdraw to itself. */
function assertMainMaySign(td, address) {
  if (!td.primaryType.startsWith(HL_USER_SIGNED_PREFIX)) return;
  if (!MAIN_MAY_SIGN.has(td.primaryType)) {
    throw signerError("SIGN_TYPE_REFUSED", `Refusing to sign ${td.primaryType} with the main wallet.`, "Only ApproveAgent and a withdrawal to the wallet itself are allowed.");
  }
  if (td.primaryType.endsWith(":Withdraw") && String(td.message.destination ?? "").toLowerCase() !== address.toLowerCase()) {
    throw signerError("SIGN_TYPE_REFUSED", "Refusing a withdrawal to an address other than the signing wallet.", "A withdrawal always goes to the same wallet.");
  }
}

export const SESSION_WALLET_DEFAULT = true;

export async function mainSigner({ idempotencyKey } = {}) {
  const address = mainAddress();
  const nextKey = keyCounter(idempotencyKey);
  return {
    address,
    walletScope: "main",
    async signTypedData(...args) {
      const td = normalizeTypedData(args);
      assertMainMaySign(td, address);
      return ledgeredSign(nextKey(), td, (t) => mainAccount(address).signTypedData(t));
    },
    async sendTransaction({ chainId, to, data, value = 0n }) {
      const callKey = nextKey();
      if (Number(chainId) !== arbitrum.id) {
        throw signerError("UNSUPPORTED_CHAIN", `Local signer only sends on Arbitrum (42161), got ${chainId}.`);
      }
      const ledger = readJson(LEDGER_FILE) ?? {};
      if (callKey && ledger[callKey]) {
        const prev = ledger[callKey];
        if (prev.to !== to || prev.data !== data) throw keyReused(callKey);
        return { hash: prev.hash, status: "replayed" };
      }
      const wallet = createWalletClient({
        account: mainAccount(address),
        chain: arbitrum,
        transport: http(process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc"),
      });
      const hash = await wallet.sendTransaction({ to, data, value: BigInt(value) });
      if (callKey) writeJson(LEDGER_FILE, { ...ledger, [callKey]: { to, data, hash, at: new Date().toISOString() } });
      return { hash, status: "submitted" };
    },
  };
}

async function extraAgents(user) {
  const res = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "extraAgents", user }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw signerError("HL_UNREACHABLE", `extraAgents responded ${res.status}`);
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

/** Live check for the env key; validUntil null means "never expires". */
async function isApprovedLive(main, agentAddress) {
  const found = (await extraAgents(main)).find((a) => String(a.address).toLowerCase() === agentAddress.toLowerCase());
  if (!found) return false;
  return found.validUntil == null || Number(found.validUntil) > Date.now();
}

function wrapAgent({ id, label, main, privateKey, approved, generated, onApproved, nextKey }) {
  const account = privateKeyToAccount(privateKey);
  const agent = {
    id,
    label,
    address: account.address,
    signerWallet: main,
    approved,
    generated,
    pending: null,
    getAddress: () => account.address,
    async signTypedData(...args) {
      // bevo-server scopes its ledger per route; agent-key signs are route agent_key.
      const callKey = nextKey();
      return ledgeredSign(callKey && `agent_key|${callKey}`, normalizeTypedData(args), (td) => account.signTypedData(td));
    },
    toViemAccount() {
      return {
        address: account.address,
        type: "local",
        // Exactly one declared parameter: @nktkas/hyperliquid detects viem local accounts by arity.
        signTypedData: async (typedData) => agent.signTypedData(typedData),
      };
    },
    async markApproved() {
      await onApproved?.();
      agent.approved = true;
    },
  };
  return agent;
}

export async function agentKey({ label = "outcome", rotate = false, idempotencyKey, create = true } = {}) {
  const main = mainAddress();
  const nextKey = keyCounter(idempotencyKey);

  if (!rotate) {
    // 1) A key generated earlier by this dev signer (also what --rotate writes).
    const file = readJson(KEY_FILE);
    if (file && file.label === label && file.main?.toLowerCase() === main.toLowerCase()) {
      return wrapAgent({
        id: `dev-file:${label}`,
        label,
        main,
        privateKey: file.privateKey,
        approved: Boolean(file.approved),
        generated: false,
        nextKey,
        onApproved: () => writeJson(KEY_FILE, { ...file, approved: true, approvedAt: new Date().toISOString() }),
      });
    }
    // 2) The owner's already-approved agent key; `approved` is checked live.
    if (process.env.OUTCOME_AGENT_PRIVATE_KEY) {
      const privateKey = normalizeKey(process.env.OUTCOME_AGENT_PRIVATE_KEY);
      return wrapAgent({
        id: "dev-env:OUTCOME_AGENT_PRIVATE_KEY",
        label,
        main,
        privateKey,
        approved: await isApprovedLive(main, privateKeyToAccount(privateKey).address),
        generated: false,
        nextKey,
      });
    }
    if (!create) return null;
  }

  // 3) Fresh key (rotate, or nothing exists yet). Never reuse an old address.
  const privateKey = generatePrivateKey();
  const record = { label, main, address: privateKeyToAccount(privateKey).address, privateKey, approved: false, createdAt: new Date().toISOString() };
  writeJson(KEY_FILE, record);
  return wrapAgent({
    id: `dev-file:${label}`,
    label,
    main,
    privateKey,
    approved: false,
    generated: true,
    nextKey,
    onApproved: () => writeJson(KEY_FILE, { ...record, approved: true, approvedAt: new Date().toISOString() }),
  });
}
