// Unit tests for lib/common.mjs. No network: pure functions and fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  parseUsdAmount,
  okEnvelope,
  errorEnvelope,
  envelopeFromError,
  pendingEnvelope,
  toJson,
  SkillError,
  assertDepositAmount,
  assertWithdrawAmount,
  planWithdraw,
  withdrawLedgerHit,
  assertKeyFresh,
  nktkasMainWallet,
  floorCents,
  validateOrder,
  agentApproval,
  classifyAgentHealth,
  requireValidAgent,
  mapExchangeError,
  classifyExchangeError,
  placeOrderFailure,
  stripTypedData,
  nktkasAgentWallet,
  hip4AgentSigner,
  pendingTrap,
  resolveSideIndex,
  computeNext,
  decimalString,
  ceilCents,
  agentNameFor,
  SIGNER_FLAGS,
  loadSigner,
  RESUME_FLAGS,
  idempotencyKeyFrom,
  minNotionalFor,
  MIN_ORDER_NOTIONAL,
  savePending,
  loadPending,
  clearPending,
  pendingDir,
  rethrowWithResume,
  SCRIPTS_DIR,
  SKILL_ROOT,
  normalizeCode,
  settledNames,
  budgetLeftMs,
  stepBudgetMs,
  SCRIPT_BUDGET_MS,
  BUDGET_MARGIN_MS,
} from "../scripts/lib/common.mjs";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const MAIN = "0x6dcf5c604b5e6b8c28a6be1c629387485037beac";
const AGENT = "0x42b0519883930ad9791de0f38387fcf18fe2b9d4";
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
};

// --- arg parsing -----------------------------------------------------------

test("parseArgs: values, =values, booleans, defaults", () => {
  const a = parseArgs(["--amount", "5", "--resume=req_1", "--sign-by-duty-wallet"], {
    ...RESUME_FLAGS,
    amount: { type: "string", required: true },
  });
  assert.deepEqual(a, { amount: "5", resume: "req_1" });
  // agent-key scripts are not resumable: --resume is an unknown flag there
  assert.equal(codeOf(() => parseArgs(["--resume", "x"], SIGNER_FLAGS)), "BAD_ARGS");
  const b = parseArgs(["--amount", "5"], { ...SIGNER_FLAGS, amount: { type: "string" } });
  assert.deepEqual(b, { amount: "5" });
});

test("parseArgs: legacy --sign-by-duty-wallet is a no-op with one stderr note", () => {
  const notes = [];
  const realError = console.error;
  console.error = (m) => notes.push(String(m));
  try {
    const a = parseArgs(["--sign-by-duty-wallet", "--amount", "5", "--sign-by-duty-wallet=true"], { ...SIGNER_FLAGS, amount: { type: "string" } });
    assert.deepEqual(a, { amount: "5" });
  } finally {
    console.error = realError;
  }
  assert.equal(notes.length, 1);
  assert.match(notes[0], /sign-by-duty-wallet/);
});

test("loadSigner: a signer without SESSION_WALLET_DEFAULT -> SIGNER_OUTDATED", async () => {
  const dir = mkdtempSync(join(tmpdir(), "old-signer-"));
  const prev = process.env.BEVO_SIGNER;
  try {
    const old = join(dir, "old.mjs");
    writeFileSync(old, "export async function mainSigner(){}\nexport async function agentKey(){}\n");
    process.env.BEVO_SIGNER = old;
    await assert.rejects(loadSigner(), (e) => e.code === "SIGNER_OUTDATED");
    const ok = join(dir, "ok.mjs");
    writeFileSync(ok, "export const SESSION_WALLET_DEFAULT = true;\nexport async function mainSigner(){}\nexport async function agentKey(){}\n");
    process.env.BEVO_SIGNER = ok;
    assert.equal((await loadSigner()).SESSION_WALLET_DEFAULT, true);
  } finally {
    if (prev === undefined) delete process.env.BEVO_SIGNER;
    else process.env.BEVO_SIGNER = prev;
  }
});

test("parseArgs: rejects unknown, missing value, missing required, positional, duplicates", () => {
  const spec = { amount: { type: "string", required: true }, all: { type: "boolean" } };
  assert.equal(codeOf(() => parseArgs(["--nope", "1"], spec)), "BAD_ARGS");
  assert.equal(codeOf(() => parseArgs(["--amount"], spec)), "BAD_ARGS");
  assert.equal(codeOf(() => parseArgs(["--amount", "--all"], spec)), "BAD_ARGS");
  assert.equal(codeOf(() => parseArgs([], spec)), "BAD_ARGS");
  assert.equal(codeOf(() => parseArgs(["5"], spec)), "BAD_ARGS");
  assert.equal(codeOf(() => parseArgs(["--amount", "1", "--amount", "2"], spec)), "BAD_ARGS");
});

test("parseUsdAmount", () => {
  assert.equal(parseUsdAmount("5"), 5);
  assert.equal(parseUsdAmount("12.345678"), 12.345678);
  for (const bad of ["0", "-1", "abc", "1e3", "1.1234567", ""]) assert.equal(codeOf(() => parseUsdAmount(bad)), "BAD_ARGS", bad);
});

// --- envelope --------------------------------------------------------------

test("envelope shapes", () => {
  assert.deepEqual(okEnvelope("done", { a: 1 }), { ok: true, status: "done", data: { a: 1 }, error: null });
  assert.deepEqual(errorEnvelope("X", "m", { hint: "h" }), { ok: false, status: "error", data: null, error: { code: "X", message: "m", hint: "h" } });
  assert.equal(toJson({ n: 10n }), '{"n":"10"}');
});

test("envelopeFromError: SkillError keeps code/status/hint", () => {
  const env = envelopeFromError(new SkillError("NEEDS_DEPOSIT", "m", { hint: "h", status: "needs_deposit" }));
  assert.equal(env.ok, false);
  assert.equal(env.status, "needs_deposit");
  assert.equal(env.error.code, "NEEDS_DEPOSIT");
});

test("envelopeFromError: signer coded error and unknown error never leak a stack", () => {
  const e = new Error("deposit/approve need the main wallet key");
  e.code = "MAIN_SIGNER_UNAVAILABLE";
  assert.equal(envelopeFromError(e).error.code, "MAIN_SIGNER_UNAVAILABLE");
  const env = envelopeFromError(new TypeError("boom"));
  assert.equal(env.error.code, "UNEXPECTED");
  assert.ok(!/\n\s+at |\.mjs:\d+/.test(toJson(env)) && !toJson(env).includes("\\n"), "no stack frames");
});

const pendingErr = (fields) => Object.assign(new Error("wait"), { name: "PendingOwnerAction", ...fields });

test("resumable main-wallet signature -> pending_owner_signature with --resume <key>", () => {
  const err = pendingErr({ kind: "signature", key: "k1:1", route: "execute", approvalId: "a1", resumable: true });
  assert.throws(() => rethrowWithResume(err, "k1"));
  assert.match(err.resumeCommand, / --resume k1$/);
  const env = envelopeFromError(err);
  assert.equal(env.ok, true);
  assert.equal(env.status, "pending_owner_signature");
  assert.equal(env.data.approvalId, "a1");
  assert.match(env.data.resume, /--resume k1$/);
});

test("signer/server codes pass through normalised; never free-text mapped", () => {
  assert.equal(normalizeCode("key_reused"), "KEY_REUSED");
  assert.equal(normalizeCode("signerSealed"), "SIGNER_SEALED");
  assert.equal(normalizeCode(" SIGN-TYPE refused "), "SIGN_TYPE_REFUSED");
  const e1 = Object.assign(new Error("dup"), { code: "key_reused" });
  assert.equal(envelopeFromError(e1).error.code, "KEY_REUSED");
  // a signer error whose text mentions "does not exist" keeps its own code
  const e2 = Object.assign(new Error("agent key 42 does not exist"), { code: "not_found" });
  assert.equal(envelopeFromError(e2).error.code, "NOT_FOUND");
  // an uncoded error is UNEXPECTED, not AGENT_INVALID
  assert.equal(envelopeFromError(new Error("User or API Wallet 0xabc does not exist.")).error.code, "UNEXPECTED");
});

test("approval_rejected / approval_expired -> OWNER_DECLINED", () => {
  for (const code of ["approval_rejected", "approval_expired", "APPROVAL_REJECTED", "approvalExpired"]) {
    const env = envelopeFromError(Object.assign(new Error("no"), { code }));
    assert.equal(env.error.code, "OWNER_DECLINED", code);
    assert.match(env.error.hint, /NEW --idempotency-key/);
  }
});

test("pendingTrap rethrows a coded signer error swallowed by an SDK", async () => {
  const trap = pendingTrap();
  const err = Object.assign(new Error("dup"), { code: "KEY_REUSED" });
  await assert.rejects(trap.run(async () => { throw err; }));
  assert.throws(() => trap.check({ pending: null }), (e) => e === err);
});

test("time budget: one constant, steps capped by what is left", () => {
  assert.ok(SCRIPT_BUDGET_MS <= 110_000, "must answer before the 120 s shell timeout");
  const t0 = 1_000_000;
  assert.equal(budgetLeftMs(t0, t0), SCRIPT_BUDGET_MS - BUDGET_MARGIN_MS);
  assert.equal(budgetLeftMs(t0 + SCRIPT_BUDGET_MS, t0), 0);
  assert.equal(stepBudgetMs(30_000, t0, t0), 30_000);
  assert.equal(stepBudgetMs(30_000, t0 + SCRIPT_BUDGET_MS - BUDGET_MARGIN_MS - 5_000, t0), 5_000);
});

test("settled names are rendered, never raw template:...", () => {
  const fake = (_spec, questions) => ({ parsedName: "Bulgaria", parsedQuestionName: questions[0]?.name ?? null });
  const s1 = settledNames({ spec: { outcome: 1, name: "template:x" }, question: { question: { settled: 9 }, name: "Bulgaria v Iceland" } }, [], fake);
  assert.deepEqual(s1, { name: "Bulgaria", question: "Bulgaria v Iceland" });
  const raw = (spec) => ({ parsedName: spec.name });
  assert.deepEqual(settledNames({ spec: { outcome: 1, name: "template:sportsContestParticipant2" } }, [], raw), { name: null, question: null });
  const boom = () => { throw new Error("x"); };
  assert.deepEqual(settledNames({ spec: { outcome: 1, name: "BTC above 90k" } }, [], boom), { name: "BTC above 90k", question: null });
});

test("agent-key authorization is NOT resumable -> authorization_timeout", () => {
  const env = envelopeFromError(pendingErr({ kind: "authorization", key: "k2:1", route: "agent_key", approvalId: "a2", resumable: false }));
  assert.equal(env.ok, false);
  assert.equal(env.status, "authorization_timeout");
  assert.equal(env.error.code, "AUTHORIZATION_TIMEOUT");
  assert.equal(env.data.resume, undefined);
  assert.match(env.error.hint, /NEW --idempotency-key/);
  assert.equal(pendingEnvelope(pendingErr({ kind: "authorization" })).status, "authorization_timeout");
});

test("idempotency keys: given, resume, generated, validated", () => {
  assert.equal(idempotencyKeyFrom({ "idempotency-key": "duty-7:slot-2026-11-19T10" }, "place_bet"), "duty-7:slot-2026-11-19T10");
  assert.equal(idempotencyKeyFrom({ resume: "pm-deposit-x" }, "deposit"), "pm-deposit-x");
  assert.match(idempotencyKeyFrom({}, "cancel", { isDev: true }), /^pm-cancel-[0-9a-f-]{36}$/);
  assert.notEqual(idempotencyKeyFrom({}, "cancel", { isDev: true }), idempotencyKeyFrom({}, "cancel", { isDev: true }));
  // production signer: the key is mandatory
  assert.equal(codeOf(() => idempotencyKeyFrom({}, "place_bet")), "IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(codeOf(() => idempotencyKeyFrom({}, "deposit", { isDev: false })), "IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(codeOf(() => idempotencyKeyFrom({ "idempotency-key": "bad key!" }, "x")), "BAD_ARGS");
  assert.equal(codeOf(() => idempotencyKeyFrom({ resume: "a", "idempotency-key": "b" }, "x")), "BAD_ARGS");
});

test("pending store under $HOME/.cache/prediction-market/pending (duty HOME respected)", () => {
  const prev = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "pm-home-"));
  try {
    assert.equal(pendingDir(), join(process.env.HOME, ".cache", "prediction-market", "pending"));
    savePending("pm-setup_agent-1", { script: "setup_agent", nonce: 123, agentAddress: AGENT, typedData: { message: { nonce: 123n } } });
    const rec = loadPending("pm-setup_agent-1", "setup_agent");
    assert.equal(rec.nonce, 123);
    assert.equal(rec.typedData.message.nonce, "123");
    assert.equal(codeOf(() => loadPending("pm-setup_agent-1", "deposit")), "RESUME_MISMATCH");
    clearPending("pm-setup_agent-1");
    assert.equal(codeOf(() => loadPending("pm-setup_agent-1", "setup_agent")), "RESUME_NOT_FOUND");
  } finally {
    process.env.HOME = prev;
  }
});

test("paths come from import.meta.url, not ~/skills", () => {
  assert.equal(basename(SCRIPTS_DIR), "scripts");
  assert.ok(existsSync(join(SKILL_ROOT, "package.json")), "package.json lives at the skill root");
  assert.ok(!existsSync(join(SCRIPTS_DIR, "package.json")), "no package.json under scripts/");
});

// --- money guards ----------------------------------------------------------

test("deposit: below 5 USDC hard-blocked; dev cap $10", () => {
  assert.equal(codeOf(() => assertDepositAmount(4.99)), "AMOUNT_BELOW_MINIMUM");
  assert.equal(codeOf(() => assertDepositAmount(4.99, { isDev: true })), "AMOUNT_BELOW_MINIMUM");
  assert.equal(codeOf(() => assertDepositAmount(5)), null);
  assert.equal(codeOf(() => assertDepositAmount(10, { isDev: true })), null);
  assert.equal(codeOf(() => assertDepositAmount(10.01, { isDev: true })), "DEV_CAP_EXCEEDED");
  assert.equal(codeOf(() => assertDepositAmount(50, { isDev: false })), null);
});

test("order floor is one constant, used for both sides today", () => {
  assert.equal(MIN_ORDER_NOTIONAL, 2);
  assert.equal(minNotionalFor("buy"), MIN_ORDER_NOTIONAL);
  assert.equal(minNotionalFor("sell"), MIN_ORDER_NOTIONAL);
  assert.equal(codeOf(() => validateOrder({ size: "3", price: "0.5", side: "sell" })), "ORDER_BELOW_MINIMUM");
});

test("order: whole shares, price in (0,1), notional >= $2, dev cap", () => {
  assert.deepEqual(validateOrder({ size: "5", price: "0.42" }), { size: 5, price: 0.42, notional: 2.1 });
  assert.equal(codeOf(() => validateOrder({ size: "4", price: "0.42" })), "ORDER_BELOW_MINIMUM");
  assert.equal(codeOf(() => validateOrder({ size: "5.5", price: "0.42" })), "BAD_ARGS");
  assert.equal(codeOf(() => validateOrder({ size: "0", price: "0.42" })), "BAD_ARGS");
  assert.equal(codeOf(() => validateOrder({ size: "-3", price: "0.42" })), "BAD_ARGS");
  assert.equal(codeOf(() => validateOrder({ size: "10", price: "1" })), "BAD_ARGS");
  assert.equal(codeOf(() => validateOrder({ size: "10", price: "0" })), "BAD_ARGS");
  assert.equal(codeOf(() => validateOrder({ size: "10", price: "1.2" })), "BAD_ARGS");
  assert.equal(codeOf(() => validateOrder({ size: "10", price: "0.123456" })), "BAD_ARGS");
  assert.equal(codeOf(() => validateOrder({ size: "20", price: "0.5", isDev: true })), null); // exactly $10
  assert.equal(codeOf(() => validateOrder({ size: "21", price: "0.5", isDev: true })), "DEV_CAP_EXCEEDED");
  assert.equal(codeOf(() => validateOrder({ size: "21", price: "0.5", isDev: false })), null);
});

// --- agent validity (platform signals only) --------------------------------

const roleOk = { role: "agent", data: { user: MAIN } };

test("agentApproval: validUntil null means never expires (unlike SDK agentStatus)", () => {
  const st = agentApproval([{ address: AGENT, name: "Butler", validUntil: null }], AGENT, NOW);
  assert.equal(st.approved, true);
  assert.equal(st.validUntil, null);
  assert.equal(st.expiringSoon, false);
});

test("agentHealth signal 1: extraAgents present/expiring/expired/absent", () => {
  const h = (validUntil, agents) =>
    classifyAgentHealth({ agents: agents ?? [{ address: AGENT.toUpperCase().replace("0X", "0x"), name: "bevo", validUntil }], role: roleOk, main: MAIN, agentAddress: AGENT, now: NOW });
  assert.equal(h(null).code, "AGENT_OK");
  assert.equal(h(NOW + 90 * DAY).code, "AGENT_OK");
  const exp = h(NOW + 13 * DAY);
  assert.equal(exp.code, "AGENT_EXPIRING");
  assert.equal(exp.valid, true);
  assert.equal(exp.daysLeft, 13);
  assert.equal(exp.mustRotate, false);
  const rot = h(NOW + 6 * DAY);
  assert.equal(rot.code, "AGENT_EXPIRING");
  assert.equal(rot.valid, true);
  assert.equal(rot.mustRotate, true);
  assert.equal(h(NOW + 20 * DAY).expiringSoon, false);
  assert.equal(h(NOW).code, "AGENT_INVALID"); // validUntil <= now
  assert.equal(h(NOW - 1).valid, false);
  assert.equal(h(null, []).code, "AGENT_INVALID"); // absent
  assert.equal(h(null, [{ address: "0x" + "1".repeat(40), name: "Butler", validUntil: null }]).code, "AGENT_INVALID");
});

test("agentHealth signal 2: userRole must be agent of THIS main", () => {
  const agents = [{ address: AGENT, name: "bevo", validUntil: NOW + 90 * DAY }];
  const h = (role) => classifyAgentHealth({ agents, role, main: MAIN, agentAddress: AGENT, now: NOW });
  assert.equal(h(roleOk).valid, true);
  assert.equal(h({ role: "agent", data: { user: MAIN.toUpperCase().replace("0X", "0x") } }).valid, true);
  assert.equal(h({ role: "missing" }).code, "AGENT_INVALID");
  assert.equal(h({ role: "agent", data: { user: "0x" + "2".repeat(40) } }).code, "AGENT_INVALID");
  assert.equal(h({ role: "user" }).code, "AGENT_INVALID");
  assert.equal(h(null).code, "AGENT_INVALID");
});

test("agentHealth: no key at all is invalid; requireValidAgent hints rotate", () => {
  const h = classifyAgentHealth({ agents: [], role: null, main: MAIN, agentAddress: null, now: NOW });
  assert.equal(h.code, "AGENT_INVALID");
  try {
    requireValidAgent(h);
    assert.fail("should throw");
  } catch (e) {
    assert.equal(e.code, "AGENT_INVALID");
    assert.equal(e.status, "needs_agent");
    assert.match(e.hint, /setup_agent\.mjs --rotate/);
  }
  assert.doesNotThrow(() => requireValidAgent({ valid: true, code: "AGENT_EXPIRING" }));
});

// --- exchange error mapping ------------------------------------------------

test("signal 3: 'does not exist' -> AGENT_INVALID with rotate hint", () => {
  const m = mapExchangeError("User or API Wallet 0x42b0519883930ad9791de0f38387fcf18fe2b9d4 does not exist.");
  assert.equal(m.code, "AGENT_INVALID");
  assert.match(m.hint, /setup_agent\.mjs --rotate/);
  assert.match(m.message, /does not exist/);
});

test("signal 6: unknown exchange text -> EXCHANGE_ERROR, never AGENT_INVALID", () => {
  for (const t of ["Order has invalid size.", "Too many cumulative requests sent", "Post only order would have immediately matched", ""]) {
    const m = classifyExchangeError(t);
    assert.equal(m.code, "EXCHANGE_ERROR", t);
    assert.match(m.hint, /status\.mjs/);
  }
  assert.equal(classifyExchangeError("Must deposit before performing actions.").code, "NEEDS_DEPOSIT");
  assert.equal(classifyExchangeError("Insufficient spot balance asset=10000").code, "INSUFFICIENT_BALANCE");
});

test("placeOrderFailure: per-order, whole-request, local and unknown results", () => {
  assert.equal(placeOrderFailure({ success: false, status: "error", error: "Insufficient spot balance" }).code, "INSUFFICIENT_BALANCE");
  assert.equal(
    placeOrderFailure({ success: false, error: "Exchange returned non-ok status", raw: "User or API Wallet 0xabc does not exist." }).code,
    "AGENT_INVALID",
  );
  assert.equal(placeOrderFailure({ success: false, error: "Exchange returned non-ok status", raw: "Some new rule" }).code, "EXCHANGE_ERROR");
  assert.equal(placeOrderFailure({ success: false, error: "Notional 1.5 below minimum 2" }).code, "ORDER_INVALID");
  assert.equal(placeOrderFailure({ success: false, error: "fetch failed" }).code, "ORDER_UNKNOWN");
});

// --- signer adapters -------------------------------------------------------

test("stripTypedData drops EIP712Domain and undeclared message keys", () => {
  const td = stripTypedData({
    domain: { name: "HyperliquidSignTransaction" },
    types: { EIP712Domain: [], "HyperliquidTransaction:X": [{ name: "amount", type: "string" }] },
    primaryType: "HyperliquidTransaction:X",
    message: { amount: "1", type: "x", signatureChainId: "0xa4b1" },
  });
  assert.deepEqual(td.types, { "HyperliquidTransaction:X": [{ name: "amount", type: "string" }] });
  assert.deepEqual(td.message, { amount: "1" });
});

test("nktkas wallet: built from toViemAccount(), arity 1, owner wait trapped", async () => {
  const pending = pendingErr({ kind: "authorization", key: "k:1", route: "agent_key", resumable: false });
  let seen;
  const agent = {
    address: AGENT,
    pending: null,
    toViemAccount: () => ({ address: AGENT, signTypedData: async (td) => { seen = td; throw pending; } }),
  };
  const trap = pendingTrap();
  const w = nktkasAgentWallet(agent, trap);
  assert.equal(w.signTypedData.length, 1);
  assert.equal(w.address, AGENT);
  await assert.rejects(w.signTypedData({ domain: {}, types: { EIP712Domain: [], Agent: [{ name: "source", type: "string" }] }, primaryType: "Agent", message: { source: "a", extra: 1 } }));
  assert.deepEqual(seen.types, { Agent: [{ name: "source", type: "string" }] });
  assert.deepEqual(seen.message, { source: "a" });
  assert.throws(() => trap.check(agent), (e) => e.key === "k:1");
});

test("trap.check: signer reporting via .pending -> authorization_timeout", () => {
  const trap = pendingTrap();
  assert.doesNotThrow(() => trap.check({ pending: null }));
  let thrown;
  try {
    trap.check({ pending: { key: "k:2", route: "agent_key", approvalId: "a9" } });
  } catch (e) {
    thrown = e;
  }
  assert.equal(thrown?.name, "PendingOwnerAction");
  const env = envelopeFromError(thrown);
  assert.equal(env.status, "authorization_timeout");
  assert.equal(env.data.approvalId, "a9");
});

test("hip4 signer: forwards the 3-arg (domain, types, value) form unchanged", async () => {
  let seen;
  const agent = { address: AGENT, signTypedData: async (...a) => { seen = a; return "0x" + "11".repeat(65); } };
  const s = hip4AgentSigner(agent, pendingTrap());
  assert.equal(await s.getAddress(), AGENT);
  await s.signTypedData({ name: "Exchange" }, { Agent: [{ name: "source", type: "string" }] }, { source: "a" });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[2], { source: "a" });
});

// --- misc ------------------------------------------------------------------

test("resolveSideIndex", () => {
  const sides = [{ name: "template:Yes", parsedName: "Yes" }, { name: "template:No", parsedName: "No" }];
  assert.equal(resolveSideIndex("YES", sides), 0);
  assert.equal(resolveSideIndex("no", sides), 1);
  assert.equal(resolveSideIndex("1", sides), 1);
  assert.equal(resolveSideIndex("Hypurr", [{ name: "Hypurr" }, { name: "Other" }]), 0);
  assert.equal(codeOf(() => resolveSideIndex("maybe", sides)), "BAD_ARGS");
});

test("computeNext decisions", () => {
  const hl = (o) => ({ role: "user", unified: false, spotUsdcFree: 0, perpsWithdrawable: 0, ...o });
  const ok = { valid: true, code: "AGENT_OK", everCreated: true };
  assert.equal(computeNext({ hl: hl({ role: "missing" }), agent: ok }).status, "needs_deposit");
  assert.equal(computeNext({ hl: hl({ spotUsdcFree: 1 }), agent: ok }).status, "needs_deposit");
  assert.equal(computeNext({ hl: hl({ spotUsdcFree: 5 }), agent: { valid: false, everCreated: true } }).status, "needs_agent");
  assert.equal(computeNext({ hl: hl({ perpsWithdrawable: 5 }), agent: ok }).status, "needs_spot");
  assert.equal(computeNext({ hl: hl({ unified: true, spotUsdcFree: 5 }), agent: ok }).status, "ready");
  assert.equal(computeNext({ hl: hl({ unified: true, spotUsdcFree: 5 }), agent: { valid: true, code: "AGENT_EXPIRING", daysLeft: 10, mustRotate: false } }).status, "ready");
  const rot = computeNext({ hl: hl({ unified: true, spotUsdcFree: 5 }), agent: { valid: true, code: "AGENT_EXPIRING", daysLeft: 3, mustRotate: true } });
  assert.equal(rot.status, "needs_agent");
  assert.equal(rot.rotate, true);
  assert.equal(computeNext({ hl: hl({ spotUsdcFree: 1 }), agent: ok }).suggestedDepositUsdc, 5);
});

test("decimalString / ceilCents / agentNameFor", () => {
  assert.equal(decimalString(1.5, 2), "1.5");
  assert.equal(decimalString(2, 2), "2");
  assert.equal(ceilCents(1.231), 1.24);
  assert.equal(ceilCents(1.23), 1.23);
  assert.equal(agentNameFor({ isDev: false }), "Butler");
  const prev = process.env.DEV_AGENT_NAME;
  delete process.env.DEV_AGENT_NAME;
  assert.equal(agentNameFor({ isDev: true }), "bevo-dev");
  if (prev !== undefined) process.env.DEV_AGENT_NAME = prev;
});

test("envelopeFromError: the server's IDEMPOTENCY_KEY_REUSED reaches the owner as KEY_REUSED", () => {
  const err = Object.assign(new Error("used"), { code: "IDEMPOTENCY_KEY_REUSED" });
  assert.equal(envelopeFromError(err).error.code, "KEY_REUSED");
});

// --- withdrawal ------------------------------------------------------------

const wHl = (o) => ({ role: "user", unified: false, spotUsdcFree: 0, perpsWithdrawable: 0, ...o });

test("assertWithdrawAmount: minimum 2, dev cap $10", () => {
  assert.equal(codeOf(() => assertWithdrawAmount(1.99)), "AMOUNT_BELOW_MINIMUM");
  assert.equal(codeOf(() => assertWithdrawAmount(2)), null);
  assert.equal(codeOf(() => assertWithdrawAmount(50, { isDev: false })), null);
  assert.equal(codeOf(() => assertWithdrawAmount(10, { isDev: true })), null);
  assert.equal(codeOf(() => assertWithdrawAmount(10.01, { isDev: true })), "DEV_CAP_EXCEEDED");
  assert.equal(codeOf(() => assertWithdrawAmount(1, { isDev: true })), "AMOUNT_BELOW_MINIMUM");
});

test("planWithdraw: ready when perps covers the amount", () => {
  const plan = planWithdraw({ hl: wHl({ perpsWithdrawable: 10, spotUsdcFree: 3 }), amount: 6 });
  assert.deepEqual(plan, { status: "ready", amount: 6, receiveUsdc: 5 });
});

test("planWithdraw: needs_perps when only spot covers the gap", () => {
  const plan = planWithdraw({ hl: wHl({ perpsWithdrawable: 1, spotUsdcFree: 9 }), amount: 5.5 });
  assert.equal(plan.status, "needs_perps");
  assert.equal(plan.gap, 4.5);
  assert.equal(plan.receiveUsdc, 4.5);
});

test("planWithdraw: insufficient and nothing to withdraw", () => {
  assert.equal(codeOf(() => planWithdraw({ hl: wHl({ perpsWithdrawable: 1, spotUsdcFree: 1 }), amount: 3 })), "INSUFFICIENT_HL_BALANCE");
  assert.equal(codeOf(() => planWithdraw({ hl: wHl({ unified: true, spotUsdcFree: 2 }), amount: 3 })), "INSUFFICIENT_HL_BALANCE");
  assert.equal(codeOf(() => planWithdraw({ hl: wHl(), all: true })), "NOTHING_TO_WITHDRAW");
  assert.equal(codeOf(() => planWithdraw({ hl: wHl({ unified: true, spotUsdcFree: 0.004 }), all: true })), "NOTHING_TO_WITHDRAW");
});

test("planWithdraw: unified pays out of the one (spot) balance", () => {
  const plan = planWithdraw({ hl: wHl({ unified: true, spotUsdcFree: 8 }), amount: 8 });
  assert.deepEqual(plan, { status: "ready", amount: 8, receiveUsdc: 7 });
});

test("planWithdraw: all floors to cents; standard mode with spot money asks for perps", () => {
  const ready = planWithdraw({ hl: wHl({ perpsWithdrawable: 12.349999 }), all: true });
  assert.deepEqual(ready, { status: "ready", amount: 12.34, receiveUsdc: 11.34 });
  const unified = planWithdraw({ hl: wHl({ unified: true, spotUsdcFree: 7.019 }), all: true });
  assert.equal(unified.amount, 7.01);
  const spotOnly = planWithdraw({ hl: wHl({ perpsWithdrawable: 2, spotUsdcFree: 3.555 }), all: true });
  assert.equal(spotOnly.status, "needs_perps");
  assert.equal(spotOnly.amount, 5.55);
  assert.equal(spotOnly.gap, 3.55);
});

test("withdrawLedgerHit matches a withdraw row by nonce only", () => {
  const ledger = [
    { time: 1, hash: "0x1", delta: { type: "deposit", usdc: "5" } },
    { time: 2, hash: "0x2", delta: { type: "withdraw", usdc: "5", nonce: 111, fee: "1" } },
    { time: 3, hash: "0x3", delta: { type: "withdraw", usdc: "3", nonce: 222, fee: "1" } },
  ];
  assert.equal(withdrawLedgerHit(ledger, 222).hash, "0x3");
  assert.equal(withdrawLedgerHit(ledger, 333), null);
  assert.equal(withdrawLedgerHit([{ delta: { type: "deposit", nonce: 111 } }], 111), null);
  assert.equal(withdrawLedgerHit(null, 111), null);
});

test("nktkas main wallet: arity 1, strips domain type, signs via mainSigner, owner wait trapped", async () => {
  let seen;
  const signer = {
    address: MAIN,
    signTypedData: async (td) => {
      seen = td;
      return "0xsig";
    },
  };
  const trap = pendingTrap();
  const w = nktkasMainWallet(signer, trap);
  assert.equal(w.signTypedData.length, 1);
  assert.equal(w.address, MAIN);
  const td = { domain: {}, types: { EIP712Domain: [], "HyperliquidTransaction:Withdraw": [{ name: "amount", type: "string" }] }, primaryType: "HyperliquidTransaction:Withdraw", message: { amount: "5", extra: 1 } };
  assert.equal(await w.signTypedData(td), "0xsig");
  assert.deepEqual(seen.types, { "HyperliquidTransaction:Withdraw": [{ name: "amount", type: "string" }] });
  assert.deepEqual(seen.message, { amount: "5" });
  const pending = pendingErr({ kind: "signature", key: "k:1", route: "typed_data", resumable: true });
  const w2 = nktkasMainWallet({ address: MAIN, signTypedData: async () => { throw pending; } }, trap);
  await assert.rejects(w2.signTypedData(td));
  assert.throws(() => trap.check(), (e) => e.key === "k:1");
});

test("floorCents never rounds up", () => {
  assert.equal(floorCents(1.239999), 1.23);
  assert.equal(floorCents(5), 5);
  assert.equal(floorCents(0.004), 0);
});

test("withdrawLedgerHit also matches Hyperliquid's microsecond nonce", () => {
  const ledger = [{ delta: { type: "withdraw", usdc: "1.0", nonce: 1795120390089000, fee: "1.0" }, hash: "0xw" }];
  assert.equal(withdrawLedgerHit(ledger, 1795120390089).hash, "0xw");
  assert.equal(withdrawLedgerHit(ledger, 1795120390090), null);
});

test("assertKeyFresh: a key the ledger holds is KEY_REUSED before any other check", async () => {
  const asked = [];
  const signer = (state) => ({ keyStatus: async (key, opts) => (asked.push([key, opts.route]), { state }) });
  await assertKeyFresh(signer("not_found"), "bet-1", { route: "agent_key" });
  assert.deepEqual(asked, [["bet-1:1", "agent_key"]]);
  await assert.rejects(assertKeyFresh(signer("executed"), "bet-1", { route: "agent_key" }), (e) => e.code === "KEY_REUSED");
  await assert.rejects(assertKeyFresh(signer("manual"), "dep-1", { resumeHint: "resume it" }), (e) => e.hint === "resume it");
  await assertKeyFresh({}, "bet-1");
  await assertKeyFresh({ keyStatus: async () => null }, "bet-1");
  await assertKeyFresh({ keyStatus: async () => { throw new Error("down"); } }, "bet-1");
});
