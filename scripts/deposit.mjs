#!/usr/bin/env node
// MOVES MONEY. Deposit USDC from the main wallet on Arbitrum to Hyperliquid:
// a plain ERC-20 transfer of native USDC to Bridge2, then wait for the credit.
//
//   node deposit.mjs --amount <usdc> [--idempotency-key <key>]
//   node deposit.mjs --resume <key>          (after pending_owner_signature or deposit_pending)
//
// status: done | deposit_pending | pending_owner_signature
// Time: answers within the shared script budget (SCRIPT_BUDGET_MS in lib/common.mjs).
// It waits briefly for the receipt and the credit, then returns deposit_pending
// rather than polling for minutes: run status.mjs a minute later.
// Gas: with the dev signer the main wallet pays ETH (NEEDS_GAS); in production the
// paymaster takes Arbitrum gas in USDC, so amount + DEPOSIT_USDC_HEADROOM is required.
// Resumable: the step is saved to $HOME/.cache/prediction-market/pending/<key>.json and the
// signer call is repeated with the SAME idempotency key, so the signer returns the original
// result instead of sending a second transfer. Never start a NEW deposit after deposit_pending.

import {
  assertKeyFresh,
  runScript,
  parseArgs,
  okEnvelope,
  loadSigner,
  parseUsdAmount,
  assertDepositAmount,
  readArbitrumBalances,
  readHlBalances,
  arbitrumClient,
  hlInfo,
  sleep,
  round6,
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
  ARBITRUM_CHAIN_ID,
  ARBITRUM_USDC,
  HL_BRIDGE2,
  USDC_DECIMALS,
} from "./lib/common.mjs";

const SCRIPT = "deposit";
/** Production pays gas in USDC via the paymaster: keep this much above the amount. */
const DEPOSIT_USDC_HEADROOM = 0.5;
const RECEIPT_WAIT_CAP_MS = 45_000;
const CREDIT_WAIT_CAP_MS = 40_000;
const POLL_MS = 5_000;

runScript(async () => {
  const args = parseArgs(process.argv.slice(2), { ...RESUME_FLAGS, amount: { type: "string" } });
  const signerMod = await loadSigner();
  const key = idempotencyKeyFrom(args, SCRIPT, { isDev: Boolean(signerMod.isDev) });
  if (!args.resume) {
    await assertKeyFresh(signerMod, key, {
      route: "execute",
      resumeHint: `This deposit key already ran: re-check it with --resume ${key}. Never start another deposit with a new key until status shows this one did not happen.`,
    });
  }
  const signer = await signerMod.mainSigner({ idempotencyKey: key, deadline: scriptDeadline() });
  const main = signer.address;
  const client = await arbitrumClient();

  let rec;
  if (args.resume) {
    rec = loadPending(key, SCRIPT);
    if (rec.mainWallet.toLowerCase() !== main.toLowerCase()) {
      throw new SkillError("RESUME_MISMATCH", "The pending deposit was started from a different wallet.");
    }
    if (args.amount && parseUsdAmount(args.amount, "amount") !== rec.amount) {
      throw new SkillError("RESUME_MISMATCH", `The pending deposit is for ${rec.amount} USDC, not ${args.amount}.`);
    }
  } else {
    if (!args.amount) throw new SkillError("BAD_ARGS", "--amount is required", { hint: "Check the command in SKILL.md." });
    const amount = parseUsdAmount(args.amount, "amount");
    assertDepositAmount(amount, { isDev: Boolean(signerMod.isDev) });

    const { encodeFunctionData, erc20Abi, parseUnits } = await import("viem");
    const units = parseUnits(String(amount), USDC_DECIMALS);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [HL_BRIDGE2, units] });

    // Pre-flight: enough native USDC, plus gas (ETH in dev, USDC headroom in production).
    const arb = await readArbitrumBalances(main);
    if (arb.usdcRaw < units) {
      throw new SkillError("INSUFFICIENT_USDC", `Main wallet has ${arb.usdc} USDC on Arbitrum; ${amount} needed.`, {
        hint: "Fund the main wallet with native USDC on Arbitrum (not USDC.e).",
        data: { arbitrumUsdc: arb.usdc },
      });
    }
    if (signerMod.isDev) {
      const [gas, gasPrice] = await Promise.all([
        client.estimateGas({ account: main, to: ARBITRUM_USDC, data }).catch(() => 80_000n),
        client.getGasPrice(),
      ]);
      const needWei = (gas * gasPrice * 3n) / 2n;
      if (arb.ethWei < needWei) {
        throw new SkillError("NEEDS_GAS", `Main wallet has ${arb.eth} ETH on Arbitrum; about ${Number(needWei) / 1e18} ETH is needed for gas.`, {
          hint: "Send a little ETH (e.g. 0.0005) to the main wallet on Arbitrum.",
          data: { arbitrumEth: arb.eth },
        });
      }
    } else if (arb.usdc < amount + DEPOSIT_USDC_HEADROOM) {
      throw new SkillError(
        "NEEDS_HEADROOM",
        `Main wallet has ${arb.usdc} USDC on Arbitrum; depositing ${amount} needs ${amount + DEPOSIT_USDC_HEADROOM} (gas is paid in USDC).`,
        {
          hint: `Deposit at most ${Math.floor((arb.usdc - DEPOSIT_USDC_HEADROOM) * 100) / 100} USDC (minimum 5), or ask the owner to add USDC on Arbitrum.`,
          data: { arbitrumUsdc: arb.usdc, headroom: DEPOSIT_USDC_HEADROOM },
        },
      );
    }

    const before = await readHlBalances(main);
    rec = {
      script: SCRIPT,
      mainWallet: main,
      amount,
      chainId: ARBITRUM_CHAIN_ID,
      to: ARBITRUM_USDC,
      data,
      beforeTotal: before.spotUsdcTotal + (before.unified ? 0 : before.perpsWithdrawable),
      startTime: Date.now() - 60_000,
    };
    savePending(key, rec);
  }

  let sent;
  try {
    sent = await signer.sendTransaction({ chainId: rec.chainId, to: rec.to, data: rec.data, value: 0n });
  } catch (err) {
    rethrowWithResume(err, key);
  }
  const resume = `${currentCommand()} --resume ${key}`;
  const pendingNote = "Transfer sent; Hyperliquid has not shown the credit yet. Run status.mjs in a minute. Do NOT deposit again (the resume command only re-checks).";
  const base = { amountUsdc: rec.amount, mainWallet: main, idempotencyKey: key, txStatus: sent?.status ?? null };
  if (!sent?.hash) {
    return okEnvelope("deposit_pending", {
      ...base,
      txHash: null,
      resume,
      note: "The signer accepted the transfer but has no transaction hash yet. Run status.mjs in a minute. Do NOT deposit again (the resume command only re-checks).",
    });
  }

  const hash = sent.hash;
  const receiptBudget = stepBudgetMs(RECEIPT_WAIT_CAP_MS);
  const receipt = receiptBudget > 2_000
    ? await client.waitForTransactionReceipt({ hash, timeout: receiptBudget }).catch(() => null)
    : null;
  if (receipt && receipt.status !== "success") {
    clearPending(key);
    throw new SkillError("DEPOSIT_TX_FAILED", `The USDC transfer reverted on Arbitrum (${hash}).`, {
      hint: "Nothing reached Hyperliquid. Check the wallet balance with status.mjs.",
      data: { txHash: hash },
    });
  }

  const credited = await waitForCredit(main, rec);
  const out = { ...base, txHash: hash, arbiscan: `https://arbiscan.io/tx/${hash}` };
  if (credited) {
    clearPending(key);
    return okEnvelope("done", { ...out, credit: credited });
  }
  return okEnvelope("deposit_pending", {
    ...out,
    receiptConfirmed: Boolean(receipt),
    resume,
    note: pendingNote,
  });
});

async function waitForCredit(main, rec) {
  const deadline = Date.now() + stepBudgetMs(CREDIT_WAIT_CAP_MS);
  while (Date.now() < deadline) {
    try {
      const ledger = await hlInfo({ type: "userNonFundingLedgerUpdates", user: main, startTime: rec.startTime });
      const hit = (Array.isArray(ledger) ? ledger : []).find(
        (row) => row?.delta?.type === "deposit" && Math.abs(Number(row.delta.usdc) - rec.amount) < 0.000001,
      );
      if (hit) return { via: "ledger", hlHash: hit.hash, time: hit.time };
      const now = await readHlBalances(main);
      const nowTotal = now.spotUsdcTotal + (now.unified ? 0 : now.perpsWithdrawable);
      if (round6(nowTotal - rec.beforeTotal) >= rec.amount - 0.01) {
        return { via: "balance", before: rec.beforeTotal, after: round6(nowTotal) };
      }
    } catch {
      // transient read failure: keep polling
    }
    if (Date.now() + POLL_MS >= deadline) break;
    await sleep(POLL_MS);
  }
  return null;
}
