#!/usr/bin/env node
// One read of everything the other steps depend on. Read-only, never signs.
//
//   node status.mjs [--need <usd>]
//   node status.mjs --address 0x...            (read-only override, no signer needed)
//
// status: ready | needs_deposit | needs_agent | needs_spot  (data.next explains)

import {
  runScript,
  parseArgs,
  okEnvelope,
  loadSigner,
  readHlBalances,
  readArbitrumBalances,
  fetchExtraAgents,
  agentApproval,
  agentHealth,
  agentNameFor,
  parseUsdAmount,
  SkillError,
  AGENT_KEY_LABEL,
  MIN_ORDER_NOTIONAL,
  computeNext,
} from "./lib/common.mjs";

runScript(async () => {
  const args = parseArgs(process.argv.slice(2), {
    address: { type: "string" },
    need: { type: "string" },
  });
  const need = args.need ? parseUsdAmount(args.need, "need") : MIN_ORDER_NOTIONAL;

  let main;
  let agentKeyObj = null;
  let signerMod = null;
  let signerScope = null;
  if (args.address) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(args.address)) throw new SkillError("BAD_ARGS", "--address is not an address");
    main = args.address;
  } else {
    signerMod = await loadSigner();
    const signer = await signerMod.mainSigner({});
    main = signer.address;
    signerScope = signer.walletScope ?? null;
    agentKeyObj = await signerMod.agentKey({
      label: AGENT_KEY_LABEL,
      rotate: false,
      create: false,
    });
  }

  const [hl, arb, agents] = await Promise.all([
    readHlBalances(main),
    readArbitrumBalances(main).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) })),
    fetchExtraAgents(main),
  ]);

  let agent = null;
  if (signerMod) {
    // Validity comes only from agentHealth (extraAgents + userRole), never from the signer's flag.
    const health = await agentHealth(main, agentKeyObj?.address ?? null);
    agent = {
      ...health,
      address: agentKeyObj?.address ?? null,
      keyId: agentKeyObj?.id ?? null,
      everCreated: Boolean(agentKeyObj),
      storedApproved: Boolean(agentKeyObj?.approved),
      expectedName: agentNameFor(signerMod),
    };
  }

  const arbOk = arb && !arb.error;
  const next = computeNext({ hl, arb: arbOk ? arb : null, agent, need });

  return okEnvelope(next.status, {
    mainWallet: main,
    walletScope: signerScope,
    agent,
    allAgents: agents.map((a) => agentApproval(agents, a.address)),
    hyperliquid: {
      role: hl.role,
      abstraction: hl.abstraction,
      unified: hl.unified,
      spotUsdcFree: hl.spotUsdcFree,
      spotUsdcHold: hl.spotUsdcHold,
      perpsWithdrawable: hl.perpsWithdrawable,
      perpsAccountValue: hl.perpsAccountValue,
    },
    arbitrum: arbOk ? { usdc: arb.usdc, eth: arb.eth } : { error: arb?.error ?? "unavailable" },
    need,
    next,
  });
});
