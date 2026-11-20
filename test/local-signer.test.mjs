// Contract tests for dev/local-signer.mjs. No network: the agent key comes from a
// throwaway key generated here, and the dev key file is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const req = createRequire(new URL("package.json", root));
const { generatePrivateKey, privateKeyToAccount } = await import(pathToFileURL(req.resolve("viem/accounts")).href);
const { recoverTypedDataAddress } = await import(pathToFileURL(req.resolve("viem")).href);

const throwaway = generatePrivateKey();
const MAIN = privateKeyToAccount(generatePrivateKey()).address;
process.env.OUTCOME_MAIN_WALLET = MAIN;
delete process.env.DEV_MAIN_PRIVATE_KEY;
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
process.env.DEV_SIGNER_LEDGER = join(mkdtempSync(join(tmpdir(), "local-signer-")), "ledger.json");

const signer = await import(fileURLToPath(new URL("dev/local-signer.mjs", root)));

const TD = {
  domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
  types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
  message: { source: "a", connectionId: "0x" + "ab".repeat(32) },
};

test("contract surface", async () => {
  assert.equal(signer.isDev, true);
  const main = await signer.mainSigner({ idempotencyKey: "t" });
  assert.equal(main.address, MAIN);
  assert.equal(typeof main.signTypedData, "function");
  assert.equal(typeof main.sendTransaction, "function");
});

test("session wallet: no flag needed, scope main, constant exported", async () => {
  assert.equal(signer.SESSION_WALLET_DEFAULT, true);
  const main = await signer.mainSigner({ signByDutyWallet: undefined, idempotencyKey: "scope" });
  assert.equal(main.walletScope, "main");
  assert.equal(main.address, MAIN);
  const bare = await signer.mainSigner();
  assert.equal(bare.walletScope, "main");
});

test("main wallet without DEV_MAIN_PRIVATE_KEY -> MAIN_SIGNER_UNAVAILABLE", async () => {
  const main = await signer.mainSigner({});
  await assert.rejects(main.signTypedData({ ...TD, primaryType: "Agent" }), (e) => e.code === "MAIN_SIGNER_UNAVAILABLE");
});

test("agent signTypedData accepts hip4 3-arg and viem object shapes (same signature)", async () => {
  const prevKey = process.env.OUTCOME_AGENT_PRIVATE_KEY;
  process.env.OUTCOME_AGENT_PRIVATE_KEY = throwaway;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("[]", { status: 200 }); // extraAgents: not approved
  try {
    const agent = await signer.agentKey({ label: "outcome", create: false, idempotencyKey: "t" });
    for (const k of ["id", "label", "address", "signerWallet", "approved", "pending"]) assert.ok(k in agent, k);
    assert.equal(agent.signerWallet, MAIN);
    assert.equal(agent.approved, false);
    const a = await agent.signTypedData(TD.domain, TD.types, TD.message);
    const b = await agent.signTypedData({ ...TD, primaryType: "Agent", message: { ...TD.message, extra: "dropped" } });
    assert.equal(a, b);
    const viem = agent.toViemAccount();
    assert.equal(viem.signTypedData.length, 1);
    assert.equal(await viem.signTypedData({ ...TD, types: { EIP712Domain: [], ...TD.types }, primaryType: "Agent" }), a);
    const rec = await recoverTypedDataAddress({ ...TD, primaryType: "Agent", signature: a });
    assert.equal(rec, agent.address);
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.OUTCOME_AGENT_PRIVATE_KEY;
    else process.env.OUTCOME_AGENT_PRIVATE_KEY = prevKey;
  }
});

test("a reused key replays the same signature and refuses a different payload", async () => {
  const prevKey = process.env.OUTCOME_AGENT_PRIVATE_KEY;
  process.env.OUTCOME_AGENT_PRIVATE_KEY = throwaway;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("[]", { status: 200 });
  try {
    const td = { ...TD, primaryType: "Agent" };
    const first = await (await signer.agentKey({ create: false, idempotencyKey: "bet-1" })).signTypedData(td);
    const replay = await (await signer.agentKey({ create: false, idempotencyKey: "bet-1" })).signTypedData(td);
    assert.equal(replay, first);
    const rerun = await signer.agentKey({ create: false, idempotencyKey: "bet-1" });
    const newNonce = { ...td, message: { ...td.message, connectionId: "0x" + "cd".repeat(32) } };
    await assert.rejects(rerun.signTypedData(newNonce), (e) => e.code === "IDEMPOTENCY_KEY_REUSED");
    const fresh = await signer.agentKey({ create: false, idempotencyKey: "bet-2" });
    assert.notEqual(await fresh.signTypedData(newNonce), first);
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.OUTCOME_AGENT_PRIVATE_KEY;
    else process.env.OUTCOME_AGENT_PRIVATE_KEY = prevKey;
  }
});

test("rotate reports a generated key, as bevo-server does", async () => {
  const prevKey = process.env.OUTCOME_AGENT_PRIVATE_KEY;
  process.env.OUTCOME_AGENT_PRIVATE_KEY = throwaway;
  const { existsSync, renameSync } = await import("node:fs");
  const keyFile = fileURLToPath(new URL("dev/.agent-key.json", root));
  const parked = keyFile + ".test-parked";
  if (existsSync(keyFile)) renameSync(keyFile, parked);
  try {
    const agent = await signer.agentKey({ rotate: true, idempotencyKey: "rot-1" });
    assert.equal(agent.generated, true);
    assert.notEqual(agent.address, privateKeyToAccount(throwaway).address);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(keyFile, { force: true });
    if (existsSync(parked)) renameSync(parked, keyFile);
    if (prevKey === undefined) delete process.env.OUTCOME_AGENT_PRIVATE_KEY;
    else process.env.OUTCOME_AGENT_PRIVATE_KEY = prevKey;
  }
});

const WITHDRAW_TYPES = {
  "HyperliquidTransaction:Withdraw": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "amount", type: "string" },
    { name: "time", type: "uint64" },
  ],
};
const HL_DOMAIN = { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: "0x0000000000000000000000000000000000000000" };

async function withMainKey(fn) {
  const mainKey = generatePrivateKey();
  const prevWallet = process.env.OUTCOME_MAIN_WALLET;
  const prevKey = process.env.DEV_MAIN_PRIVATE_KEY;
  const address = privateKeyToAccount(mainKey).address;
  process.env.OUTCOME_MAIN_WALLET = address;
  process.env.DEV_MAIN_PRIVATE_KEY = mainKey;
  try {
    await fn(address);
  } finally {
    process.env.OUTCOME_MAIN_WALLET = prevWallet;
    if (prevKey === undefined) delete process.env.DEV_MAIN_PRIVATE_KEY;
    else process.env.DEV_MAIN_PRIVATE_KEY = prevKey;
  }
}

const withdrawTd = (destination) => ({
  domain: HL_DOMAIN,
  types: WITHDRAW_TYPES,
  primaryType: "HyperliquidTransaction:Withdraw",
  message: { hyperliquidChain: "Mainnet", destination, amount: "5", time: 1_800_000_000_000 },
});

test("main wallet signs a Withdraw to itself", async () => {
  await withMainKey(async (address) => {
    const main = await signer.mainSigner({ idempotencyKey: "wd-self" });
    const td = withdrawTd(address.toLowerCase());
    const sig = await main.signTypedData(td);
    assert.match(sig, /^0x[0-9a-f]+$/i);
    assert.equal(await recoverTypedDataAddress({ ...td, signature: sig }), address);
    const replay = await (await signer.mainSigner({ idempotencyKey: "wd-self" })).signTypedData(td);
    assert.equal(replay, sig);
  });
});

test("main wallet refuses a Withdraw to another address", async () => {
  await withMainKey(async () => {
    const main = await signer.mainSigner({ idempotencyKey: "wd-other" });
    const other = privateKeyToAccount(generatePrivateKey()).address;
    await assert.rejects(main.signTypedData(withdrawTd(other)), (e) => e.code === "SIGN_TYPE_REFUSED");
  });
});

test("main wallet refuses UsdSend and other HyperliquidTransaction types", async () => {
  await withMainKey(async (address) => {
    const main = await signer.mainSigner({ idempotencyKey: "wd-usdsend" });
    const usdSend = {
      domain: HL_DOMAIN,
      types: {
        "HyperliquidTransaction:UsdSend": [
          { name: "hyperliquidChain", type: "string" },
          { name: "destination", type: "string" },
          { name: "amount", type: "string" },
          { name: "time", type: "uint64" },
        ],
      },
      primaryType: "HyperliquidTransaction:UsdSend",
      message: { hyperliquidChain: "Mainnet", destination: address, amount: "5", time: 1_800_000_000_000 },
    };
    await assert.rejects(main.signTypedData(usdSend), (e) => e.code === "SIGN_TYPE_REFUSED");
  });
});
