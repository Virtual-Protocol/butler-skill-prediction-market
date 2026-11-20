#!/usr/bin/env node
// AGENT-SIGNED, same-account move. Make sure spot USDC covers --amount by moving
// only the gap from perps ("") to spot with agentSendAsset (destination = the
// same main wallet; an agent cannot send to anyone else). Never changes the
// account mode; in unified mode there is nothing to move.
//
//   node ensure_spot.mjs --amount <usd> [--idempotency-key <key>]
//
// status: done | needs_deposit | needs_agent | authorization_timeout
// Not resumable: an agent-key authorization that times out is reported as
// authorization_timeout (nothing moved); re-run to file a new card.

import {
  assertKeyFresh,
  runScript,
  parseArgs,
  okEnvelope,
  loadSigner,
  parseUsdAmount,
  readHlBalances,
  agentHealth,
  requireValidAgent,
  moveUsdcInAccount,
  pendingTrap,
  ceilCents,
  round6,
  sleep,
  SkillError,
  SIGNER_FLAGS,
  AGENT_KEY_LABEL,
  idempotencyKeyFrom,
  scriptDeadline,
} from "./lib/common.mjs";

runScript(async () => {
    const args = parseArgs(process.argv.slice(2), { ...SIGNER_FLAGS, amount: { type: "string", required: true } });
    const amount = parseUsdAmount(args.amount, "amount");
    const signerMod = await loadSigner();
    const idempotencyKey = idempotencyKeyFrom(args, "ensure_spot", { isDev: Boolean(signerMod.isDev) });
    await assertKeyFresh(signerMod, idempotencyKey, { route: "agent_key" });
    const main = (await signerMod.mainSigner({ idempotencyKey, deadline: scriptDeadline() })).address;

    const hl = await readHlBalances(main);
    const base = { mainWallet: main, target: amount, abstraction: hl.abstraction };
    if (hl.unified) {
      if (hl.spotUsdcFree >= amount) return okEnvelope("done", { ...base, moved: 0, spotUsdcFree: hl.spotUsdcFree, note: "Unified account: spot and perps are one balance." });
      throw needsDeposit(amount, hl.spotUsdcFree, base);
    }
    if (hl.spotUsdcFree >= amount) return okEnvelope("done", { ...base, moved: 0, spotUsdcFree: hl.spotUsdcFree });

    const gap = ceilCents(amount - hl.spotUsdcFree);
    if (hl.perpsWithdrawable < gap) throw needsDeposit(amount, round6(hl.spotUsdcFree + hl.perpsWithdrawable), base);

    const agent = await signerMod.agentKey({
      label: AGENT_KEY_LABEL,
      rotate: false,
      create: false,
      idempotencyKey,
      deadline: scriptDeadline(),
    });
    requireValidAgent(await agentHealth(main, agent?.address ?? null));

    await moveUsdcInAccount({
      agent,
      trap: pendingTrap(),
      main,
      sourceDex: "",
      destinationDex: "spot",
      amount: gap,
      errorData: { gap },
    });

    let after = null;
    for (let i = 0; i < 5; i++) {
      after = await readHlBalances(main);
      if (after.spotUsdcFree >= amount - 0.000001) break;
      await sleep(1_500);
    }
    return okEnvelope("done", { ...base, moved: gap, idempotencyKey, spotUsdcFree: after.spotUsdcFree, perpsWithdrawable: after.perpsWithdrawable });
});

function needsDeposit(amount, available, base) {
  return new SkillError("NEEDS_DEPOSIT", `Hyperliquid holds $${available} USDC in total; $${amount} is needed.`, {
    hint: "Run deposit.mjs --amount <at least 5> first.",
    status: "needs_deposit",
    data: base,
  });
}
