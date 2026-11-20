#!/usr/bin/env node
// AGENT-SIGNED. Cancel one resting outcome order, or all of them.
//
//   node cancel.mjs --order-id <oid> [--market <id>] [--idempotency-key <key>]
//   node cancel.mjs --all [--market <id>] [--idempotency-key <key>]
//
// status: done | needs_agent | authorization_timeout   (not resumable)

import {
  assertKeyFresh,
  runScript,
  parseArgs,
  okEnvelope,
  loadSigner,
  createHip4,
  agentHealth,
  requireValidAgent,
  hip4AgentSigner,
  pendingTrap,
  exchangeSkillError,
  SkillError,
  SIGNER_FLAGS,
  AGENT_KEY_LABEL,
  idempotencyKeyFrom,
  scriptDeadline,
} from "./lib/common.mjs";

runScript(async () => {
    const args = parseArgs(process.argv.slice(2), {
      ...SIGNER_FLAGS,
      market: { type: "string" },
      "order-id": { type: "string" },
      all: { type: "boolean" },
    });
    if (Boolean(args["order-id"]) === args.all) throw new SkillError("BAD_ARGS", "Pass exactly one of --order-id <oid> or --all");
    if (args["order-id"] && !/^\d+$/.test(args["order-id"])) throw new SkillError("BAD_ARGS", "--order-id must be numeric");
    if (args.market && !/^\d+$/.test(args.market)) throw new SkillError("BAD_ARGS", "--market must be numeric");
    const signerMod = await loadSigner();
    const idempotencyKey = idempotencyKeyFrom(args, "cancel", { isDev: Boolean(signerMod.isDev) });
    await assertKeyFresh(signerMod, idempotencyKey, { route: "agent_key" });
    const main = (await signerMod.mainSigner({ idempotencyKey, deadline: scriptDeadline() })).address;

    const hip4 = await createHip4();
    try {
      const { parseSideCoin } = await import("@outcome.xyz/hip4");
      const open = (await hip4.account.fetchOpenOrders(main))
        .filter((o) => /^#\d+$/.test(o.coin) && parseSideCoin(o.coin))
        .map((o) => ({ ...o, marketId: String(parseSideCoin(o.coin).outcomeId) }))
        .filter((o) => !args.market || o.marketId === args.market);

      const targets = args.all ? open : open.filter((o) => String(o.oid) === args["order-id"]);
      if (targets.length === 0) {
        if (args.all) return okEnvelope("done", { cancelled: [], note: "No open outcome orders." });
        throw new SkillError("ORDER_NOT_FOUND", `Order ${args["order-id"]} is not open (filled, cancelled, or another market).`, {
          hint: "Check account.mjs.",
        });
      }

      const agent = await signerMod.agentKey({
        label: AGENT_KEY_LABEL,
        rotate: false,
        create: false,
        idempotencyKey,
        deadline: scriptDeadline(),
      });
      requireValidAgent(await agentHealth(main, agent?.address ?? null));

      const trap = pendingTrap();
      await hip4.auth.initAuth(main, hip4AgentSigner(agent, trap));
      let res;
      try {
        // Always pass outcome: without it the SDK cancels on side 0's asset.
        res = await hip4.trading.cancelOrder(targets.map((o) => ({ marketId: o.marketId, orderId: String(o.oid), outcome: o.coin })));
      } catch (err) {
        trap.check(agent);
        throw exchangeSkillError(err?.message ?? String(err));
      }
      trap.check(agent);
      if (res.status !== "ok") {
        throw exchangeSkillError(typeof res.response === "string" ? res.response : JSON.stringify(res.response ?? null));
      }
      const statuses = res.response?.data?.statuses ?? [];
      const results = targets.map((o, i) => ({
        orderId: String(o.oid),
        marketId: o.marketId,
        coin: o.coin,
        ok: statuses[i] === "success",
        error: statuses[i] === "success" ? null : statuses[i]?.error ?? "no status returned",
      }));
      const failed = results.filter((r) => !r.ok);
      if (failed.length === results.length) throw exchangeSkillError(failed[0].error, { results });
      return okEnvelope("done", { cancelled: results.filter((r) => r.ok), failed });
    } finally {
      hip4.destroy();
    }
});
