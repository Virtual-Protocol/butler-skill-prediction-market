#!/usr/bin/env node
// SIGNS WITH THE MAIN WALLET. Withdraw USDC from Hyperliquid to Arbitrum, always to
// the signing wallet's own address (there is no destination flag): a withdraw3
// signature from the main wallet. The trading key can never do this.
//
//   node withdraw.mjs --amount <usdc> | --all [--idempotency-key <key>]
//   node withdraw.mjs --resume <key>         (after pending_owner_signature or WITHDRAW_UNKNOWN)
//
// status: withdraw_pending | needs_perps | pending_owner_signature
// Hyperliquid pays out of the perps balance. needs_perps (standard accounts whose
// money sits in spot): run ensure_perps.mjs --amount <data.amount>, then run this again.
// Resumable: {amount, time} is saved under the key BEFORE signing. The nonce is
// that `time`, so --resume rebuilds identical typed data (the signer returns the
// same signature for the same key). Resume checks Hyperliquid's ledger for the
// nonce first and never signs or sends again when the withdrawal is already there.

import {
  assertKeyFresh,
  runScript,
  parseArgs,
  okEnvelope,
  loadSigner,
  parseUsdAmount,
  assertWithdrawAmount,
  planWithdraw,
  withdrawLedgerHit,
  nktkasMainWallet,
  readHlBalances,
  hlInfo,
  pendingTrap,
  decimalString,
  round6,
  sleep,
  idempotencyKeyFrom,
  scriptDeadline,
  stepBudgetMs,
  savePending,
  loadPending,
  clearPending,
  rethrowWithResume,
  currentCommand,
  SkillError,
  RESUME_FLAGS,
  HL_SIGNATURE_CHAIN_ID,
  HL_WITHDRAW_FEE_USDC,
} from "./lib/common.mjs";

const SCRIPT = "withdraw";
const ARRIVES_IN_MINUTES = 5;
const CONFIRM_WAIT_CAP_MS = 15_000;
const POLL_MS = 3_000;
const DUPLICATE_NONCE_RE = /duplicate nonce|nonce.*(already|used)|already used.*nonce/i;

runScript(async () => {
  const args = parseArgs(process.argv.slice(2), { ...RESUME_FLAGS, amount: { type: "string" }, all: { type: "boolean" } });
  const signerMod = await loadSigner();
  const key = idempotencyKeyFrom(args, SCRIPT, { isDev: Boolean(signerMod.isDev) });
  if (!args.resume) {
    await assertKeyFresh(signerMod, key, {
      route: "execute",
      resumeHint: `This withdrawal key already ran: re-check it with --resume ${key}. Never start another withdrawal with a new key until status shows this one did not happen.`,
    });
  }
  const signer = await signerMod.mainSigner({ idempotencyKey: key, deadline: scriptDeadline() });
  const main = signer.address;

  let rec;
  if (args.resume) {
    rec = loadPending(key, SCRIPT);
    if (rec.mainWallet.toLowerCase() !== main.toLowerCase()) {
      throw new SkillError("RESUME_MISMATCH", "The pending withdrawal was started from a different wallet.");
    }
    if (args.all || (args.amount && parseUsdAmount(args.amount, "amount") !== rec.amount)) {
      throw new SkillError("RESUME_MISMATCH", `The pending withdrawal is for ${rec.amount} USDC; pass only --resume.`);
    }
    const hit = await ledgerHit(main, rec);
    if (hit) {
      clearPending(key);
      return pendingResult(rec, main, true);
    }
  } else {
    if (Boolean(args.amount) === args.all) {
      throw new SkillError("BAD_ARGS", "pass exactly one of --amount <usdc> or --all", { hint: "Check the command in SKILL.md." });
    }
    const isDev = Boolean(signerMod.isDev);
    const requested = args.amount ? parseUsdAmount(args.amount, "amount") : null;
    if (requested !== null) assertWithdrawAmount(requested, { isDev });
    const hl = await readHlBalances(main);
    const plan = planWithdraw({ hl, amount: requested, all: args.all });
    assertWithdrawAmount(plan.amount, { isDev });
    if (plan.status === "needs_perps") {
      return okEnvelope("needs_perps", {
        mainWallet: main,
        amountUsdc: plan.amount,
        receiveUsdc: plan.receiveUsdc,
        gap: plan.gap,
        spotUsdcFree: hl.spotUsdcFree,
        perpsWithdrawable: hl.perpsWithdrawable,
        next: `Run ensure_perps.mjs --amount ${decimalString(plan.amount, 2)}, then run withdraw.mjs again.`,
      });
    }
    const now = Date.now();
    rec = { script: SCRIPT, mainWallet: main, amount: plan.amount, time: now, startTime: now - 60_000 };
    savePending(key, rec);
  }

  const { ExchangeClient, HttpTransport } = await import("@nktkas/hyperliquid");
  const trap = pendingTrap();
  const exchange = new ExchangeClient({
    transport: new HttpTransport({ isTestnet: false }),
    wallet: nktkasMainWallet(signer, trap),
    signatureChainId: HL_SIGNATURE_CHAIN_ID,
    nonceManager: () => rec.time,
  });
  try {
    await exchange.withdraw3({ destination: main, amount: decimalString(rec.amount, 6) });
  } catch (err) {
    try {
      trap.check();
    } catch (pending) {
      rethrowWithResume(pending, key);
    }
    throw withdrawFailure(err, key, rec);
  }

  const hlConfirmed = Boolean(await waitForLedger(main, rec));
  clearPending(key);
  return pendingResult(rec, main, hlConfirmed);
});

function pendingResult(rec, main, hlConfirmed) {
  return okEnvelope("withdraw_pending", {
    mainWallet: main,
    destination: main,
    amountUsdc: rec.amount,
    feeUsdc: HL_WITHDRAW_FEE_USDC,
    receiveUsdc: round6(rec.amount - HL_WITHDRAW_FEE_USDC),
    hlConfirmed,
    arrivesInMinutes: ARRIVES_IN_MINUTES,
  });
}

function withdrawFailure(err, key, rec) {
  const text = String(err?.message ?? err);
  if (err?.name === "ApiRequestError") {
    clearPending(key);
    if (DUPLICATE_NONCE_RE.test(text)) {
      return new SkillError("WITHDRAW_ALREADY_SUBMITTED", `Hyperliquid reports this withdrawal was already submitted (${text}).`, {
        hint: "Do not withdraw again. Run status.mjs; the USDC arrives on Arbitrum within about 5 minutes.",
        data: { amountUsdc: rec.amount },
      });
    }
    return new SkillError("WITHDRAW_REFUSED", `Hyperliquid refused the withdrawal: ${text.slice(0, 500)}`, {
      hint: "Nothing was withdrawn. Run status.mjs, report the message, and do not retry blindly.",
      data: { amountUsdc: rec.amount, raw: text.slice(0, 500) },
    });
  }
  if (err?.name === "TransportError" || err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new SkillError("WITHDRAW_UNKNOWN", `The withdrawal may or may not have reached Hyperliquid: ${text.slice(0, 300)}`, {
      hint: `Do NOT withdraw again with a new key. Run the same command with --resume ${key}: it checks Hyperliquid first and never sends twice.`,
      data: { amountUsdc: rec.amount, resume: `${currentCommand()} --resume ${key}` },
    });
  }
  return err;
}

async function ledgerHit(main, rec) {
  const ledger = await hlInfo({ type: "userNonFundingLedgerUpdates", user: main, startTime: rec.startTime });
  return withdrawLedgerHit(ledger, rec.time);
}

async function waitForLedger(main, rec) {
  const deadline = Date.now() + stepBudgetMs(CONFIRM_WAIT_CAP_MS);
  while (Date.now() < deadline) {
    try {
      const hit = await ledgerHit(main, rec);
      if (hit) return hit;
    } catch {
      // transient read failure: keep polling
    }
    if (Date.now() + POLL_MS >= deadline) break;
    await sleep(POLL_MS);
  }
  return null;
}
