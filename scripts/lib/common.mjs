// Shared helpers for the prediction-market skill scripts.
//
// Contract every script follows:
//   - prints exactly ONE JSON object on stdout:
//       { ok, status, data, error: { code, message, hint } | null }
//   - never prints a stack trace or a key to stdout (diagnostics go to stderr)
//   - never holds a private key: all signing goes through the module named by
//     the BEVO_SIGNER env var (absolute path), loaded with dynamic import.
//   - locates its own files via import.meta.url, never ~/skills/... (a duty runs
//     with HOME = its duty dir; production also injects BEVO_SKILLS_DIR).
//
// Signer contract (architect review section 3, plus extensions marked EXT):
//   mainSigner({ idempotencyKey })
//     -> { address, signTypedData(...) -> 0x, sendTransaction({chainId,to,data,value}) -> { hash|null, status } }
//   agentKey({ label, rotate, idempotencyKey, create /*EXT, default true*/ })
//     -> { id, label, address, signerWallet, approved, generated, getAddress(), signTypedData(...),
//          toViemAccount(), markApproved(), pending } | null (only when create:false and no key)
//   signTypedData accepts (domain, types, value) AND ({ domain, types, primaryType, message }).
//   Owner waits throw PendingOwnerAction { kind, key, route, approvalId, resumable }.
//
// Pure helpers (arg parsing, guards, error mapping, agent approval maths) are
// exported so the unit tests can exercise them without any network.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** scripts/ directory of this skill, wherever it is installed. */
export const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** Skill root (holds package.json and node_modules). */
export const SKILL_ROOT = dirname(SCRIPTS_DIR);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ARBITRUM_CHAIN_ID = 42161;
/** Native USDC on Arbitrum One (6 decimals). Never USDC.e. */
export const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export const USDC_DECIMALS = 6;
/** Hyperliquid Bridge2 on Arbitrum One. Deposits below 5 USDC are lost. */
export const HL_BRIDGE2 = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7";
/** Mainnet spot USDC token id ("name:tokenId") used by agentSendAsset. */
export const HL_SPOT_USDC_TOKEN = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";
export const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
export const DEFAULT_ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";
/** Hyperliquid wants every user-signed EIP-712 action on Arbitrum's chain id. */
export const HL_SIGNATURE_CHAIN_ID = "0xa4b1";

export const MIN_DEPOSIT_USDC = 5;
/** Hyperliquid withdrawal floor and flat fee (the fee comes out of the amount). Verify in a live test. */
export const MIN_WITHDRAW_USDC = 2;
export const HL_WITHDRAW_FEE_USDC = 1;
/**
 * THE order floor (USD notional = shares x price). Outcome.xyz product floor; the
 * SDK/exchange floor is $1. Single place to change; minNotionalFor() is the only
 * place that decides whether a side gets a different floor (sells: undecided).
 */
export const MIN_ORDER_NOTIONAL = 2;
/** Dev signer only: refuse any single deposit or order worth more than this. */
export const DEV_MAX_NOTIONAL = 10;
/** Agent approvals with less than this left are flagged expiringSoon (warning only). */
export const AGENT_EXPIRY_WARN_DAYS = 14;
/** Agent approvals with less than this left must be rotated (mustRotate). */
export const AGENT_ROTATE_DAYS = 7;
/** Label the signer stores this skill's agent key under (venue_credentials.venue_id). */
export const AGENT_KEY_LABEL = "outcome";
/** Hyperliquid agent name used in production. Re-approving the same name replaces the old agent. */
export const PROD_AGENT_NAME = "Butler";
/** Dev default, so local tests never replace the production "Butler" agent. */
export const DEV_AGENT_NAME_DEFAULT = "bevo-dev";
/** Account abstraction modes where spot and perps are one balance. */
export const UNIFIED_MODES = new Set(["unifiedAccount", "portfolioMargin"]);

const DAY_MS = 86_400_000;

/**
 * Time budget. Container shell commands are killed at 120 s, so every script must
 * print its JSON and exit within SCRIPT_BUDGET_MS of starting. Owner-card waits,
 * receipt waits and confirmation polls all draw from this one budget.
 */
export const SCRIPT_BUDGET_MS = 110_000;
/** Kept free at the end of the budget for the final reads and the JSON print. */
export const BUDGET_MARGIN_MS = 8_000;
const SCRIPT_STARTED_AT = Date.now();

/** Milliseconds left before the script must answer (never negative). */
export function budgetLeftMs(now = Date.now(), startedAt = SCRIPT_STARTED_AT) {
  return Math.max(0, startedAt + SCRIPT_BUDGET_MS - BUDGET_MARGIN_MS - now);
}

/**
 * Absolute ms timestamp the signer must stop waiting for an owner card by
 * (passed to mainSigner/agentKey as `deadline`, a contract EXT). The production
 * signer polls at most ~105 s; this caps it to what the script budget allows.
 */
export function scriptDeadline() {
  return SCRIPT_STARTED_AT + SCRIPT_BUDGET_MS - BUDGET_MARGIN_MS;
}

/** Wait budget for one step: min(cap, what is left of the script budget). */
export function stepBudgetMs(capMs, now = Date.now(), startedAt = SCRIPT_STARTED_AT) {
  return Math.min(capMs, budgetLeftMs(now, startedAt));
}

// ---------------------------------------------------------------------------
// Errors and the JSON envelope
// ---------------------------------------------------------------------------

/** An expected, user-explainable failure. `status` defaults to "error". */
export class SkillError extends Error {
  constructor(code, message, { hint = null, status = "error", data = null } = {}) {
    super(message);
    this.name = "SkillError";
    this.code = code;
    this.hint = hint;
    this.status = status;
    this.data = data;
  }
}

export function okEnvelope(status, data = null) {
  return { ok: true, status, data, error: null };
}

export function errorEnvelope(code, message, { hint = null, status = "error", data = null } = {}) {
  return { ok: false, status, data, error: { code, message, hint } };
}

/** JSON.stringify that survives BigInt and Date values. */
export function toJson(obj) {
  return JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

/**
 * Map an owner wait (PendingOwnerAction) to an envelope.
 *  - resumable (main-wallet signature): ok, status pending_owner_signature, with a
 *    `--resume <key>` command when the script persisted its pending state.
 *  - not resumable (agent-key authorization; the server refuses approvals > 90 s):
 *    status authorization_timeout. Nothing was executed; re-running files a new card.
 */
export function pendingEnvelope(err, resumeCommand = null) {
  const base = {
    kind: err.kind ?? null,
    key: err.key ?? null,
    route: err.route ?? null,
    approvalId: err.approvalId ?? null,
  };
  if (err.resumable) {
    return { ok: true, status: "pending_owner_signature", data: { ...base, resume: resumeCommand }, error: null };
  }
  return {
    ok: false,
    status: "authorization_timeout",
    data: base,
    error: {
      code: "AUTHORIZATION_TIMEOUT",
      message: "The owner did not authorize in time; nothing was executed.",
      hint: "Tell the owner the card expired; nothing happened. Re-place it only if the owner still wants it, and use a NEW --idempotency-key (the old card is dead).",
    },
  };
}

export function isPendingOwnerAction(err) {
  return Boolean(err) && err.name === "PendingOwnerAction";
}

/** Build a PendingOwnerAction-shaped error (used when the signer reports via `.pending`). */
export function pendingOwnerAction(fields = {}) {
  const err = new Error("Owner action pending");
  err.name = "PendingOwnerAction";
  Object.assign(err, { kind: "authorization", resumable: false, ...fields });
  return err;
}

const OWNER_DECLINED_CODES = new Set(["APPROVAL_REJECTED", "APPROVAL_EXPIRED", "OWNER_DECLINED"]);

/** "approval_rejected" / "signerSealed" / "KEY-REUSED" -> APPROVAL_REJECTED / SIGNER_SEALED / KEY_REUSED. */
export function normalizeCode(code) {
  return String(code)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/** Turn any thrown value into an envelope. Unknown errors never leak a stack. */
export function envelopeFromError(err) {
  if (isPendingOwnerAction(err)) return pendingEnvelope(err, err.resumeCommand ?? null);
  if (err instanceof SkillError) {
    return errorEnvelope(err.code, err.message, {
      hint: err.hint,
      status: err.status,
      data: err.data,
    });
  }
  // Errors raised by the signer / bevo-server carry their own code: pass it through
  // (normalised). Free-text Hyperliquid mapping is NOT applied here: it belongs only
  // to /exchange responses (exchangeSkillError / placeOrderFailure).
  if (err && typeof err.code === "string" && err.code.trim()) {
    const raw = normalizeCode(err.code);
    // bevo-server's ledger answers a reused key as IDEMPOTENCY_KEY_REUSED; SKILL.md names it KEY_REUSED.
    const code = raw === "IDEMPOTENCY_KEY_REUSED" ? "KEY_REUSED" : raw;
    if (OWNER_DECLINED_CODES.has(code)) {
      return errorEnvelope("OWNER_DECLINED", String(err.message ?? "The owner declined or let the card expire."), {
        hint: "Tell the owner nothing happened. Ask before trying again; a new attempt needs a NEW --idempotency-key.",
        data: { signerCode: code },
      });
    }
    return errorEnvelope(code, String(err.message ?? code).slice(0, 500), { hint: err.hint ?? null });
  }
  return errorEnvelope("UNEXPECTED", String(err?.message ?? err).slice(0, 500), {
    hint: "Unexpected failure. Re-run status.mjs before retrying anything that moves money.",
  });
}

/**
 * Run a script body. `main` returns an envelope (use okEnvelope) or throws.
 * Anything written with console.log is redirected to stderr so stdout stays a
 * single JSON object.
 */
export async function runScript(main) {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  console.log = (...a) => console.error(...a);
  console.info = (...a) => console.error(...a);
  let envelope;
  try {
    envelope = await main();
  } catch (err) {
    envelope = envelopeFromError(err);
    if (process.env.SKILL_DEBUG) console.error(err);
  }
  if (runIdempotencyKey) envelope = { ...envelope, idempotencyKey: runIdempotencyKey };
  stdoutWrite(toJson(envelope) + "\n");
  process.exitCode = envelope.ok ? 0 : envelope.error?.code === "BAD_ARGS" ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const LEGACY_DUTY_FLAG = "--sign-by-duty-wallet";

/**
 * Parse `--key value`, `--key=value` and boolean `--flag`.
 * spec: { name: { type: "string" | "boolean", required?: boolean } }
 * Unknown flags and positional arguments are rejected (BAD_ARGS).
 */
export function parseArgs(argv, spec) {
  const out = {};
  let legacyNoted = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === LEGACY_DUTY_FLAG || tok.startsWith(`${LEGACY_DUTY_FLAG}=`)) {
      if (!legacyNoted) console.error("[prediction-market] --sign-by-duty-wallet is ignored: the server picks the wallet from the session.");
      legacyNoted = true;
      continue;
    }
    if (!tok.startsWith("--")) throw badArgs(`unexpected argument "${tok}"`);
    let name = tok.slice(2);
    let value;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const def = spec[name];
    if (!def) throw badArgs(`unknown option --${name}`);
    if (def.type === "boolean") {
      if (value !== undefined) {
        if (value !== "true" && value !== "false") throw badArgs(`--${name} takes no value`);
        out[name] = value === "true";
      } else {
        out[name] = true;
      }
      continue;
    }
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw badArgs(`--${name} needs a value`);
      i++;
    }
    if (out[name] !== undefined) throw badArgs(`--${name} given twice`);
    out[name] = value;
  }
  for (const [name, def] of Object.entries(spec)) {
    if (def.type === "boolean" && out[name] === undefined) out[name] = false;
    if (def.required && out[name] === undefined) throw badArgs(`--${name} is required`);
  }
  return out;
}

function badArgs(message) {
  return new SkillError("BAD_ARGS", message, { hint: "Check the command in SKILL.md." });
}

/** Flags every signing script accepts. */
export const SIGNER_FLAGS = {
  "idempotency-key": { type: "string" },
};
/** Extra flag for the resumable main-wallet scripts (deposit, setup_agent). */
export const RESUME_FLAGS = { ...SIGNER_FLAGS, resume: { type: "string" } };

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,119}$/;

/**
 * Base idempotency key for this run: --resume <key> reuses the pending key,
 * else --idempotency-key (duties pass their slot key), else a fresh one.
 * The signer derives per-call keys `${base}:${n}`.
 */
export function idempotencyKeyFrom(args, scriptName, { isDev = false } = {}) {
  if (args.resume && args["idempotency-key"] && args.resume !== args["idempotency-key"]) {
    throw badArgs("--resume and --idempotency-key differ; pass only --resume");
  }
  const given = args.resume ?? args["idempotency-key"];
  if (given !== undefined) {
    if (!IDEMPOTENCY_KEY_RE.test(given)) throw badArgs("idempotency key must be 1-120 chars of [A-Za-z0-9:_.-]");
    runIdempotencyKey = given;
    return given;
  }
  if (!isDev) {
    throw new SkillError("IDEMPOTENCY_KEY_REQUIRED", `${scriptName} moves money or signs: --idempotency-key is required.`, {
      hint: "Pass a new key for every new ask, e.g. --idempotency-key pm-<step>-<YYYYMMDD-HHMM>; duties pass their slot key.",
    });
  }
  runIdempotencyKey = `pm-${scriptName}-${randomUUID()}`;
  return runIdempotencyKey;
}

/** The key this run uses; echoed as `idempotencyKey` on every JSON output. */
let runIdempotencyKey = null;

/** Parse a positive decimal USD amount with at most `maxDp` decimals. */
export function parseUsdAmount(raw, name = "amount", maxDp = USDC_DECIMALS) {
  if (typeof raw !== "string" || !/^\d+(\.\d+)?$/.test(raw.trim())) {
    throw badArgs(`--${name} must be a positive number, got "${raw}"`);
  }
  const s = raw.trim();
  const dp = s.includes(".") ? s.split(".")[1].length : 0;
  if (dp > maxDp) throw badArgs(`--${name} has more than ${maxDp} decimals`);
  const n = Number(s);
  if (!(n > 0) || !Number.isFinite(n)) throw badArgs(`--${name} must be greater than 0`);
  return n;
}

// ---------------------------------------------------------------------------
// Money guards
// ---------------------------------------------------------------------------

export function assertDepositAmount(amount, { isDev = false } = {}) {
  if (!(amount >= MIN_DEPOSIT_USDC)) {
    throw new SkillError(
      "AMOUNT_BELOW_MINIMUM",
      `Hyperliquid deposits below ${MIN_DEPOSIT_USDC} USDC are never credited (the money is lost). Refusing ${amount} USDC.`,
      { hint: `Deposit at least ${MIN_DEPOSIT_USDC} USDC.` },
    );
  }
  assertDevCap(amount, isDev, "deposit");
}

export function assertWithdrawAmount(amount, { isDev = false } = {}) {
  if (!(amount >= MIN_WITHDRAW_USDC)) {
    throw new SkillError(
      "AMOUNT_BELOW_MINIMUM",
      `The minimum withdrawal is ${MIN_WITHDRAW_USDC} USDC (a ${HL_WITHDRAW_FEE_USDC} USDC fee is taken from it). Refusing ${amount} USDC.`,
      { hint: `Withdraw at least ${MIN_WITHDRAW_USDC} USDC.` },
    );
  }
  assertDevCap(amount, isDev, "withdrawal");
}

/**
 * Decide a withdrawal from the readings. Hyperliquid pays out of the perps
 * balance; on a unified account that is the spot balance. Pure.
 *  ready       -> { status: "ready", amount, receiveUsdc }
 *  needs_perps -> { status: "needs_perps", amount, receiveUsdc, gap } (standard mode: spot covers the gap)
 * Throws NOTHING_TO_WITHDRAW (all, nothing to take) or INSUFFICIENT_HL_BALANCE.
 * `all` takes everything the account can pay out (perps + free spot), floored to cents.
 */
export function planWithdraw({ hl, amount, all = false }) {
  const perps = hl.unified ? hl.spotUsdcFree : hl.perpsWithdrawable;
  const total = hl.unified ? hl.spotUsdcFree : round6(hl.spotUsdcFree + hl.perpsWithdrawable);
  let want = amount;
  if (all) {
    want = floorCents(total);
    if (!(want > 0)) {
      throw new SkillError("NOTHING_TO_WITHDRAW", "There is no USDC on Hyperliquid to withdraw.", {
        hint: "Run status.mjs and tell your owner the balance is empty.",
        data: { available: total },
      });
    }
  }
  if (!(want <= total + 0.000001)) {
    throw new SkillError(
      "INSUFFICIENT_HL_BALANCE",
      `Hyperliquid holds $${total} USDC available; ${want} was requested.`,
      { hint: "Withdraw at most the available amount (--all takes everything), or run status.mjs.", data: { available: total } },
    );
  }
  const receiveUsdc = round6(want - HL_WITHDRAW_FEE_USDC);
  if (!hl.unified && perps + 0.000001 < want) {
    return { status: "needs_perps", amount: want, receiveUsdc, gap: ceilCents(want - perps) };
  }
  return { status: "ready", amount: want, receiveUsdc };
}

/** Ledger row (userNonFundingLedgerUpdates) of the withdrawal signed with nonce/time `time`, or null. */
export function withdrawLedgerHit(ledger, time) {
  const rows = Array.isArray(ledger) ? ledger : [];
  const ms = Number(time);
  return (
    rows.find((row) => {
      if (row?.delta?.type !== "withdraw") return false;
      const nonce = Number(row.delta.nonce);
      return nonce === ms || nonce === ms * 1000;
    }) ?? null
  );
}

/**
 * Refuses a key bevo-server's ledger already holds, before any local check runs: a replay must
 * read as KEY_REUSED, never as a balance problem a new key would "fix". An unreadable ledger or a
 * signer without `keyStatus` passes; the server still refuses a reused key when it is asked to sign.
 */
export async function assertKeyFresh(signerMod, key, { route = "execute", resumeHint = null } = {}) {
  if (!key || typeof signerMod?.keyStatus !== "function") return;
  let row = null;
  try {
    row = await signerMod.keyStatus(`${key}:1`, { route });
  } catch {
    return;
  }
  if (!row || typeof row.state !== "string" || row.state === "not_found") return;
  throw new SkillError("KEY_REUSED", `This --idempotency-key already ran (${row.state}); nothing new was sent.`, {
    hint:
      resumeHint ??
      "Run account.mjs to see what it did. Use a NEW key only for a new action your owner asked for.",
    data: { ledgerState: row.state },
  });
}

export function assertDevCap(notional, isDev, what) {
  if (isDev && notional > DEV_MAX_NOTIONAL) {
    throw new SkillError(
      "DEV_CAP_EXCEEDED",
      `Dev signer refuses a ${what} worth $${round2(notional)} (cap $${DEV_MAX_NOTIONAL}).`,
      { hint: `Use an amount of $${DEV_MAX_NOTIONAL} or less while testing with the local signer.` },
    );
  }
}

/**
 * Minimum notional for an order side. The ONLY place to exempt sells (closing
 * small positions) once the owner decides; today both sides use MIN_ORDER_NOTIONAL.
 */
export function minNotionalFor(_side) {
  return MIN_ORDER_NOTIONAL;
}

/** Parse and validate a whole-share order. Returns { size, price, notional }. */
export function validateOrder({ size, price, side = "buy", isDev = false }) {
  if (typeof size !== "string" || !/^\d+$/.test(size.trim()) || Number(size) <= 0) {
    throw new SkillError("BAD_ARGS", `--size must be a whole number of shares (> 0), got "${size}"`, {
      hint: "Shares are whole numbers. To spend about $X, use floor(X / price).",
    });
  }
  const sizeN = Number(size);
  if (!Number.isSafeInteger(sizeN)) throw badArgs("--size is too large");
  if (typeof price !== "string" || !/^0?\.\d+$|^0$|^1$/.test(price.trim())) {
    throw new SkillError("BAD_ARGS", `--price must be a probability between 0 and 1, got "${price}"`, {
      hint: "Example: --price 0.42",
    });
  }
  const priceN = Number(price);
  if (!(priceN > 0 && priceN < 1)) {
    throw new SkillError("BAD_ARGS", `--price must be strictly between 0 and 1, got ${price}`, {
      hint: "Example: --price 0.42",
    });
  }
  const decimals = price.includes(".") ? price.split(".")[1].length : 0;
  if (decimals > 5) throw badArgs("--price has more than 5 decimals (tick is 0.00001)");
  const notional = round6(sizeN * priceN);
  const floor = minNotionalFor(side);
  if (notional < floor) {
    throw new SkillError(
      "ORDER_BELOW_MINIMUM",
      `Order is worth $${round2(notional)} (${sizeN} shares x ${priceN}); the minimum is $${floor}.`,
      { hint: `Use at least ${Math.ceil(floor / priceN)} shares at this price.` },
    );
  }
  assertDevCap(notional, isDev, "order");
  return { size: sizeN, price: priceN, notional };
}

// ---------------------------------------------------------------------------
// Agent approval maths (do NOT use the SDK's agentStatus: it treats a null
// validUntil, i.e. "never expires", as already expired)
// ---------------------------------------------------------------------------

/**
 * @param agents  extraAgents response: [{ address, name, validUntil: number|null }]
 * @param address agent address to look for (case-insensitive)
 */
export function agentApproval(agents, address, now = Date.now()) {
  const lower = String(address ?? "").toLowerCase();
  const found = (agents ?? []).find((a) => String(a.address).toLowerCase() === lower);
  if (!found) {
    return {
      address,
      present: false,
      approved: false,
      name: null,
      validUntil: null,
      daysLeft: null,
      expiringSoon: false,
      mustRotate: false,
    };
  }
  const validUntil = found.validUntil == null ? null : Number(found.validUntil);
  const expired = validUntil != null && validUntil <= now;
  const daysLeft = validUntil == null ? null : Math.max(0, Math.floor((validUntil - now) / DAY_MS));
  return {
    address: found.address,
    present: true,
    approved: !expired,
    name: found.name ?? null,
    validUntil,
    validUntilIso: validUntil == null ? null : new Date(validUntil).toISOString(),
    daysLeft,
    expiringSoon: !expired && validUntil != null && validUntil - now < AGENT_EXPIRY_WARN_DAYS * DAY_MS,
    mustRotate: !expired && validUntil != null && validUntil - now < AGENT_ROTATE_DAYS * DAY_MS,
  };
}

/**
 * The ONLY source of truth for whether our agent key may sign. Pure, so the
 * unit tests can feed fixtures. Signals (see plan 2.3):
 *   1. extraAgents(main): present and (validUntil null or > now) -> valid;
 *      valid but < 14 days left -> AGENT_EXPIRING (still valid);
 *      absent or validUntil <= now -> AGENT_INVALID.
 *   2. userRole(agent): { role:"agent", data:{ user: main } } -> valid;
 *      "missing" or another user -> AGENT_INVALID.
 * Returns { valid, code: "AGENT_OK"|"AGENT_EXPIRING"|"AGENT_INVALID", reason, ...approval }.
 */
export function classifyAgentHealth({ agents, role, main, agentAddress, now = Date.now() }) {
  const approval = agentApproval(agents, agentAddress, now);
  const base = { ...approval, roleSeen: role?.role ?? null, roleUser: role?.data?.user ?? null };
  if (!agentAddress) return { ...base, valid: false, code: "AGENT_INVALID", reason: "No trading key exists yet." };
  if (!approval.present) {
    return { ...base, valid: false, code: "AGENT_INVALID", reason: "Hyperliquid does not list this key for the wallet (replaced, pruned or never approved)." };
  }
  if (!approval.approved) {
    return { ...base, valid: false, code: "AGENT_INVALID", reason: "The key's approval has expired." };
  }
  const roleOk =
    role?.role === "agent" && String(role?.data?.user ?? "").toLowerCase() === String(main).toLowerCase();
  if (!roleOk) {
    return {
      ...base,
      valid: false,
      code: "AGENT_INVALID",
      reason: `Hyperliquid's userRole for the key is ${role?.role ?? "unknown"}${role?.data?.user ? ` (user ${role.data.user})` : ""}, not an agent of this wallet.`,
    };
  }
  if (approval.expiringSoon) {
    return {
      ...base,
      valid: true,
      code: "AGENT_EXPIRING",
      reason: `Approval expires in ${approval.daysLeft} day(s)${approval.mustRotate ? "; rotate now" : ""}.`,
    };
  }
  return { ...base, valid: true, code: "AGENT_OK", reason: "Approved." };
}

/** Live wrapper: reads extraAgents(main) + userRole(agent) and classifies. */
export async function agentHealth(mainAddr, agentAddr) {
  if (!agentAddr) return classifyAgentHealth({ agents: [], role: null, main: mainAddr, agentAddress: null });
  const [agents, role] = await Promise.all([
    fetchExtraAgents(mainAddr),
    hlInfo({ type: "userRole", user: agentAddr }),
  ]);
  return classifyAgentHealth({ agents, role, main: mainAddr, agentAddress: agentAddr });
}

/** Throw AGENT_INVALID (never auto-rotate) unless the key is valid. */
export function requireValidAgent(health) {
  if (health.valid) return health;
  throw new SkillError("AGENT_INVALID", `The trading key cannot be used: ${health.reason}`, {
    hint: "Run setup_agent.mjs --rotate, then retry this command once.",
    status: "needs_agent",
    data: { agentAddress: health.address ?? null },
  });
}

export function agentNameFor(signerModule) {
  if (signerModule?.isDev) return process.env.DEV_AGENT_NAME || DEV_AGENT_NAME_DEFAULT;
  return PROD_AGENT_NAME;
}

// ---------------------------------------------------------------------------
// Exchange error mapping (Hyperliquid answers in free text)
// ---------------------------------------------------------------------------

const ERROR_TABLE = [
  {
    re: /does not exist/i,
    code: "AGENT_INVALID",
    message: "The trading key (Hyperliquid agent) is no longer approved for this wallet.",
    hint: "Run setup_agent.mjs --rotate, then retry this command once. Never re-approve the old key.",
  },
  {
    re: /Must deposit before performing actions/i,
    code: "NEEDS_DEPOSIT",
    message: "This wallet has never deposited to Hyperliquid.",
    hint: "Run deposit.mjs --amount 5 (or more) first.",
  },
  {
    re: /Insufficient spot balance|insufficient balance|Insufficient margin/i,
    code: "INSUFFICIENT_BALANCE",
    message: "Not enough spot USDC (or shares) on Hyperliquid for this order.",
    hint: "Run status.mjs; then ensure_spot.mjs --amount <order value>.",
  },
  {
    re: /Action disabled when unified account is active/i,
    code: "UNIFIED_ACCOUNT",
    message: "The account is in unified mode; spot and perps are already one balance.",
    hint: "No transfer is needed.",
  },
  {
    re: /Price must be divisible by tick size|Invalid price/i,
    code: "BAD_PRICE",
    message: "Hyperliquid rejected the price.",
    hint: "Use at most 5 decimals and stay strictly between 0 and 1.",
  },
];

/** Returns { code, message, hint } for a known Hyperliquid message, else null. */
export function mapExchangeError(text) {
  if (!text) return null;
  for (const row of ERROR_TABLE) {
    if (row.re.test(text)) return { code: row.code, message: `${row.message} (${text})`, hint: row.hint };
  }
  return null;
}

/** Like mapExchangeError but never null: unknown text -> EXCHANGE_ERROR (never AGENT_INVALID). */
export function classifyExchangeError(text) {
  return (
    mapExchangeError(text) ?? {
      code: "EXCHANGE_ERROR",
      message: `Hyperliquid rejected the request: ${String(text ?? "unknown error").slice(0, 500)}`,
      hint: "Run status.mjs first.",
    }
  );
}

/**
 * Classify a failed hip4 placeOrder result (the SDK returns errors, it does not throw):
 *  - status "error"                     -> Hyperliquid rejected this order (mapped text)
 *  - raw / "Exchange returned non-ok"   -> Hyperliquid rejected the whole request (mapped raw)
 *  - SDK pre-flight validation message  -> ORDER_INVALID (nothing was sent)
 *  - anything else (network, HTTP)      -> ORDER_UNKNOWN (may have reached Hyperliquid)
 */
export function placeOrderFailure(res, data = null) {
  if (res.status === "error") return exchangeSkillError(res.error, data);
  if (res.raw || res.error === "Exchange returned non-ok status") return exchangeSkillError(res.raw ?? res.error, data);
  const msg = String(res.error ?? "");
  if (/^(Notional|Size) .* below minimum|^Invalid |not supported|^Not authenticated/i.test(msg)) {
    return new SkillError("ORDER_INVALID", `The SDK refused the order before sending it: ${msg}`, { data });
  }
  return new SkillError("ORDER_UNKNOWN", `The order result is unknown: ${msg || "no response"}.`, {
    hint: "Do NOT retry blindly. Run account.mjs and look for the order or a fill first.",
    data,
  });
}

export function exchangeSkillError(text, data = null) {
  const m = classifyExchangeError(text);
  return new SkillError(m.code, m.message, {
    hint: m.hint,
    status: m.code === "AGENT_INVALID" ? "needs_agent" : m.code === "NEEDS_DEPOSIT" ? "needs_deposit" : "error",
    data,
  });
}

// ---------------------------------------------------------------------------
// Signer loading
// ---------------------------------------------------------------------------

export async function loadSigner() {
  const path = process.env.BEVO_SIGNER;
  if (!path) {
    throw new SkillError("SIGNER_NOT_CONFIGURED", "BEVO_SIGNER is not set.", {
      hint: "The container sets BEVO_SIGNER; locally export BEVO_SIGNER=<abs path>/dev/local-signer.mjs.",
    });
  }
  if (!isAbsolute(path)) {
    throw new SkillError("SIGNER_NOT_CONFIGURED", "BEVO_SIGNER must be an absolute path.", {
      hint: "export BEVO_SIGNER=$PWD/dev/local-signer.mjs",
    });
  }
  const mod = await import(pathToFileURL(path).href);
  if (typeof mod.mainSigner !== "function" || typeof mod.agentKey !== "function") {
    throw new SkillError("SIGNER_NOT_CONFIGURED", "BEVO_SIGNER module does not export mainSigner/agentKey.");
  }
  if (mod.SESSION_WALLET_DEFAULT !== true) {
    throw new SkillError("SIGNER_OUTDATED", "BEVO_SIGNER is an older signer that cannot pick the wallet from the session.", {
      hint: "The container must be redeployed onto the current image.",
    });
  }
  return mod;
}

/**
 * Wrap signer calls so an owner wait thrown inside an SDK (hip4 folds signer
 * errors into a { success:false } result) is still seen by the script.
 * After the SDK call returns or throws, call `trap.check(agent)`: it rethrows a
 * trapped PendingOwnerAction, or one built from the signer's `.pending`.
 */
export function pendingTrap() {
  let pending = null;
  let signerError = null;
  return {
    async run(fn) {
      try {
        return await fn();
      } catch (err) {
        // Owner waits and coded signer/server errors must reach the envelope as
        // themselves, never as SDK free text (which would be mis-mapped).
        if (isPendingOwnerAction(err)) pending = err;
        else if (err && typeof err.code === "string") signerError = err;
        throw err;
      }
    },
    check(agent) {
      if (pending) throw pending;
      if (signerError) throw signerError;
      if (agent?.pending) throw pendingOwnerAction(typeof agent.pending === "object" ? agent.pending : {});
    },
    get pending() {
      return pending;
    },
  };
}

/** Keep only the domain keys and message fields the typed data declares. */
export function stripTypedData({ domain, types, primaryType, message }) {
  const { EIP712Domain: _ignored, ...rest } = types ?? {};
  const fields = rest[primaryType] ?? [];
  const msg = {};
  for (const f of fields) msg[f.name] = message[f.name];
  return { domain, types: rest, primaryType, message: msg };
}

/**
 * HIP4Signer for hip4 initAuth(): getAddress() + signTypedData(domain, types, value).
 * Forwards the 3-arg form unchanged (the signer accepts both shapes), trapping owner waits.
 */
export function hip4AgentSigner(agent, trap) {
  return {
    getAddress: () => agent.address,
    signTypedData: (domain, types, value) => trap.run(() => agent.signTypedData(domain, types, value)),
  };
}

/**
 * Wallet for @nktkas/hyperliquid, built from agent.toViemAccount(). nktkas only
 * recognises a viem local account whose signTypedData declares exactly 1 param.
 */
export function nktkasAgentWallet(agent, trap) {
  const account = agent.toViemAccount();
  return {
    address: account.address,
    signTypedData: async (typedData) => trap.run(() => account.signTypedData(stripTypedData(typedData))),
  };
}

/**
 * Wallet for @nktkas/hyperliquid, built from mainSigner(): same shape as the agent
 * wallet (a viem local account whose signTypedData declares exactly 1 param).
 */
export function nktkasMainWallet(signer, trap) {
  return {
    address: signer.address,
    signTypedData: async (typedData) => trap.run(() => signer.signTypedData(stripTypedData(typedData))),
  };
}

/**
 * Agent-key signed move of USDC between the account's own perps ("") and spot
 * ("spot") with agentSendAsset; the destination is always the same main wallet.
 */
export async function moveUsdcInAccount({ agent, trap, main, sourceDex, destinationDex, amount, errorData = null }) {
  const { ExchangeClient, HttpTransport } = await import("@nktkas/hyperliquid");
  const exchange = new ExchangeClient({
    transport: new HttpTransport({ isTestnet: false }),
    wallet: nktkasAgentWallet(agent, trap),
    signatureChainId: HL_SIGNATURE_CHAIN_ID,
  });
  try {
    await exchange.agentSendAsset({
      destination: main,
      sourceDex,
      destinationDex,
      token: HL_SPOT_USDC_TOKEN,
      amount: decimalString(amount, 2),
      fromSubAccount: "",
    });
  } catch (err) {
    trap.check(agent);
    if (err?.name === "ApiRequestError") throw exchangeSkillError(err.message, errorData);
    throw err;
  }
  trap.check(agent);
}

// ---------------------------------------------------------------------------
// Pending main-wallet steps (resumable): $HOME/.cache/prediction-market/pending/<key>.json
// ---------------------------------------------------------------------------

export function pendingDir() {
  return join(process.env.HOME || homedir(), ".cache", "prediction-market", "pending");
}

function pendingPath(key) {
  if (!IDEMPOTENCY_KEY_RE.test(key)) throw badArgs("bad resume key");
  return join(pendingDir(), `${key.replace(/:/g, "_")}.json`);
}

export function savePending(key, record) {
  mkdirSync(pendingDir(), { recursive: true });
  writeFileSync(pendingPath(key), toJson({ ...record, key, savedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
}

export function loadPending(key, script) {
  const path = pendingPath(key);
  if (!existsSync(path)) {
    throw new SkillError("RESUME_NOT_FOUND", `No pending ${script} step saved under key ${key}.`, {
      hint: "Run status.mjs; start the step again without --resume if it is still needed.",
    });
  }
  const rec = JSON.parse(readFileSync(path, "utf8"));
  if (rec.script !== script) {
    throw new SkillError("RESUME_MISMATCH", `Key ${key} belongs to ${rec.script}, not ${script}.`);
  }
  return rec;
}

export function clearPending(key) {
  const path = pendingPath(key);
  if (existsSync(path)) unlinkSync(path);
}

/** Attach the resume command to a resumable owner wait and rethrow it. */
export function rethrowWithResume(err, key) {
  if (isPendingOwnerAction(err) && err.resumable) {
    err.resumeCommand = `${currentCommand()} --resume ${key}`;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Hyperliquid info + Arbitrum reads
// ---------------------------------------------------------------------------

export async function hlInfo(body, { retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(HL_INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status >= 500) throw new Error(`HL info ${body.type} responded ${res.status}`);
      if (!res.ok) {
        throw new SkillError("HL_INFO_FAILED", `HL info ${body.type} responded ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      if (err instanceof SkillError) throw err;
      lastErr = err;
      if (attempt < retries) await sleep(1000);
    }
  }
  throw new SkillError("HL_UNREACHABLE", `Hyperliquid info API failed: ${lastErr?.message ?? lastErr}`, {
    hint: "Network problem talking to api.hyperliquid.xyz. Retry in a minute.",
  });
}

/** Free and held spot USDC, perps withdrawable, mode, role. */
export async function readHlBalances(address) {
  const [spot, perps, mode, role] = await Promise.all([
    hlInfo({ type: "spotClearinghouseState", user: address }),
    hlInfo({ type: "clearinghouseState", user: address }),
    hlInfo({ type: "userAbstraction", user: address }),
    hlInfo({ type: "userRole", user: address }),
  ]);
  const usdc = (spot?.balances ?? []).find((b) => b.coin === "USDC");
  const spotTotal = Number(usdc?.total ?? 0);
  const spotHold = Number(usdc?.hold ?? 0);
  return {
    spotUsdcTotal: round6(spotTotal),
    spotUsdcHold: round6(spotHold),
    spotUsdcFree: round6(spotTotal - spotHold),
    perpsWithdrawable: round6(Number(perps?.withdrawable ?? 0)),
    perpsAccountValue: round6(Number(perps?.marginSummary?.accountValue ?? 0)),
    abstraction: typeof mode === "string" ? mode : null,
    unified: UNIFIED_MODES.has(mode),
    role: role?.role ?? null,
    spotBalances: spot?.balances ?? [],
  };
}

export async function fetchExtraAgents(address) {
  const agents = await hlInfo({ type: "extraAgents", user: address });
  return Array.isArray(agents) ? agents : [];
}

export function arbitrumRpcUrl() {
  return process.env.ARBITRUM_RPC_URL || DEFAULT_ARBITRUM_RPC;
}

export async function arbitrumClient() {
  const { createPublicClient, http } = await import("viem");
  const { arbitrum } = await import("viem/chains");
  return createPublicClient({ chain: arbitrum, transport: http(arbitrumRpcUrl(), { timeout: 15_000 }) });
}

export async function readArbitrumBalances(address) {
  const { erc20Abi, formatUnits, formatEther } = await import("viem");
  const client = await arbitrumClient();
  const [usdc, eth] = await Promise.all([
    client.readContract({ address: ARBITRUM_USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    client.getBalance({ address }),
  ]);
  return {
    usdcRaw: usdc,
    usdc: Number(formatUnits(usdc, USDC_DECIMALS)),
    ethWei: eth,
    eth: Number(formatEther(eth)),
  };
}

// ---------------------------------------------------------------------------
// Outcome SDK
// ---------------------------------------------------------------------------

/** Mainnet adapter (the SDK defaults to TESTNET). Caller must destroy(). */
export async function createHip4() {
  const { createHIP4Adapter } = await import("@outcome.xyz/hip4");
  const hip4 = createHIP4Adapter({ testnet: false, minOrderNotional: MIN_ORDER_NOTIONAL });
  await hip4.initialize();
  return hip4;
}

/** Resolve --outcome (YES/NO, 0/1, or a side name) to a side index. */
export function resolveSideIndex(outcome, sides) {
  const o = String(outcome ?? "").trim();
  const up = o.toUpperCase();
  if (up === "YES" || o === "0") return 0;
  if (up === "NO" || o === "1") return 1;
  const idx = (sides ?? []).findIndex(
    (s) => (s.parsedName ?? s.name ?? "").toLowerCase() === o.toLowerCase() || (s.name ?? "").toLowerCase() === o.toLowerCase(),
  );
  if (idx === 0 || idx === 1) return idx;
  throw new SkillError("BAD_ARGS", `--outcome must be YES, NO or a side name of this market, got "${outcome}"`, {
    hint: sides ? `Sides: ${sides.map((s) => s.parsedName ?? s.name).join(" / ")}` : null,
  });
}

// ---------------------------------------------------------------------------
// status.mjs decision (pure)
// ---------------------------------------------------------------------------

/** Decide the next step from the readings. */
export function computeNext({ hl, arb, agent, need = MIN_ORDER_NOTIONAL }) {
  const hlTotal = hl.unified ? hl.spotUsdcFree : round6(hl.spotUsdcFree + hl.perpsWithdrawable);
  if (hl.role === "missing" || hlTotal < need) {
    const shortfall = Math.max(MIN_DEPOSIT_USDC, ceilCents(need - hlTotal));
    return {
      status: "needs_deposit",
      reason:
        hl.role === "missing"
          ? "This wallet has never deposited to Hyperliquid."
          : `Hyperliquid holds $${hlTotal} USDC; $${need} is needed.`,
      suggestedDepositUsdc: shortfall,
      arbitrumUsdcEnough: arb ? arb.usdc >= shortfall : null,
    };
  }
  if (agent && !agent.valid) {
    return {
      status: "needs_agent",
      code: "AGENT_INVALID",
      reason: agent.everCreated
        ? "The stored trading key is not approved on Hyperliquid (replaced, pruned or never completed)."
        : "No trading key yet.",
      rotate: Boolean(agent.everCreated),
    };
  }
  if (!hl.unified && hl.spotUsdcFree < need) {
    return {
      status: "needs_spot",
      reason: `Spot USDC is $${hl.spotUsdcFree}; outcome orders spend spot USDC. Move from perps ($${hl.perpsWithdrawable}).`,
      suggestedSpotAmount: ceilCents(need),
    };
  }
  if (agent && agent.mustRotate) {
    return {
      status: "needs_agent",
      code: "AGENT_EXPIRING",
      reason: `The trading key expires in ${agent.daysLeft} day(s); rotate it now.`,
      rotate: true,
    };
  }
  if (agent && agent.code === "AGENT_EXPIRING") {
    return { status: "ready", code: "AGENT_EXPIRING", reason: `Ready, but the trading key expires in ${agent.daysLeft} day(s); run setup_agent.mjs --rotate soon.` };
  }
  return { status: "ready", reason: agent ? "Funded and the trading key is approved." : "Funded (agent not checked: --address mode)." };
}

/**
 * Readable names for a settled outcome. Settled outcomes are gone from outcomeMeta,
 * so render them the way the SDK renders live ones: classifyOutcome() with the
 * template registry (raw names look like "template:sportsContestParticipant2").
 */
export function settledNames(settled, templates, classifyOutcome) {
  const spec = settled.spec ?? {};
  const q = settled.question;
  const questions = q
    ? [{ question: q.question?.settled ?? -1, name: q.name, description: q.description, fallbackOutcome: -1, namedOutcomes: [spec.outcome], settledNamedOutcomes: [spec.outcome] }]
    : [];
  try {
    const m = classifyOutcome(spec, questions, undefined, templates ?? []);
    return { name: readable(m.parsedName) ?? readable(spec.name), question: readable(m.parsedQuestionName) ?? readable(q?.name) };
  } catch {
    return { name: readable(spec.name), question: readable(q?.name) };
  }
}

function readable(text) {
  if (!text) return null;
  return /^template:/.test(text) ? null : text;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round2 = (n) => Math.round(n * 100) / 100;
export const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** Decimal string with at most `dp` places and no trailing zeros. */
export function decimalString(n, dp = 6) {
  const s = Number(n).toFixed(dp);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Round a USD amount UP to whole cents (so a transfer always covers the gap). */
export function ceilCents(n) {
  return Math.ceil(round6(n) * 100) / 100;
}

/** Round a USD amount DOWN to whole cents (so a withdrawal never exceeds the balance). */
export function floorCents(n) {
  return Math.floor(round6(n) * 100 + 1e-9) / 100;
}

/** Shell-safe rendering of the current command for resume hints. */
export function currentCommand() {
  const script = process.argv[1] ?? "";
  const args = process.argv.slice(2);
  const filtered = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resume" || args[i] === "--idempotency-key") {
      i++;
      continue;
    }
    if (args[i].startsWith("--resume=") || args[i].startsWith("--idempotency-key=")) continue;
    filtered.push(args[i]);
  }
  return ["node", script, ...filtered].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
}
