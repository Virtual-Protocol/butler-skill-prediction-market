#!/usr/bin/env node
// AGENT-SIGNED ORDER. Place ONE limit order on a HIP-4 outcome market.
// Market orders are refused (the SDK prices them at 0.99999 / 0.00001: no
// slippage limit). Size is in whole SHARES; notional = size x price >= $2.
// Orders must run one at a time (the SDK nonce is Date.now()).
//
//   node place_bet.mjs --market <id> --outcome YES|NO --side buy|sell --size <shares> --price <0..1>
//                      [--tif GTC|ALO|FAK] [--idempotency-key <key>]
//
// status: done | needs_agent | needs_spot | authorization_timeout
// Not resumable (hip4 picks its own nonce): an authorization that times out is
// authorization_timeout and nothing was placed; re-run to file a new card.
// Duties pass their slot key as --idempotency-key so a re-fire cannot bet twice.

import {
  assertKeyFresh,
  runScript,
  parseArgs,
  okEnvelope,
  loadSigner,
  createHip4,
  validateOrder,
  resolveSideIndex,
  readHlBalances,
  agentHealth,
  requireValidAgent,
  hip4AgentSigner,
  pendingTrap,
  placeOrderFailure,
  ceilCents,
  SkillError,
  SIGNER_FLAGS,
  AGENT_KEY_LABEL,
  idempotencyKeyFrom,
  scriptDeadline,
} from "./lib/common.mjs";

const TIFS = new Set(["GTC", "ALO", "FAK"]);

runScript(async () => {
    const args = parseArgs(process.argv.slice(2), {
      ...SIGNER_FLAGS,
      market: { type: "string", required: true },
      outcome: { type: "string", required: true },
      side: { type: "string", required: true },
      size: { type: "string", required: true },
      price: { type: "string" },
      type: { type: "string" },
      tif: { type: "string" },
    });
    if (args.type && args.type !== "limit") {
      throw new SkillError("MARKET_ORDER_REFUSED", "Only limit orders are allowed (market orders have no slippage limit).", {
        hint: "Pass --price. To fill now, use the best ask (buy) or best bid (sell) from markets.mjs --id <id>, optionally with --tif FAK.",
      });
    }
    if (!args.price) {
      throw new SkillError("MARKET_ORDER_REFUSED", "--price is required: only limit orders are allowed.", {
        hint: "Read the order book with markets.mjs --id <id> and pass --price.",
      });
    }
    if (!/^\d+$/.test(args.market)) throw new SkillError("BAD_ARGS", "--market must be the numeric market id from markets.mjs");
    const side = String(args.side).toLowerCase();
    if (side !== "buy" && side !== "sell") throw new SkillError("BAD_ARGS", "--side must be buy or sell");
    const tif = (args.tif ?? "GTC").toUpperCase();
    if (!TIFS.has(tif)) throw new SkillError("BAD_ARGS", "--tif must be GTC, ALO or FAK");
    const signerMod = await loadSigner();
    const idempotencyKey = idempotencyKeyFrom(args, "place_bet", { isDev: Boolean(signerMod.isDev) });
    await assertKeyFresh(signerMod, idempotencyKey, { route: "agent_key" });
    const order = validateOrder({ size: args.size, price: args.price, side, isDev: Boolean(signerMod.isDev) });
    const main = (await signerMod.mainSigner({ idempotencyKey, deadline: scriptDeadline() })).address;

    const hip4 = await createHip4();
    try {
      const markets = await hip4.events.fetchMarkets();
      const market = (Array.isArray(markets) ? markets : []).find((m) => String(m.outcomeId) === args.market);
      if (!market) {
        const settled = await hip4.client.fetchSettledOutcome(Number(args.market)).catch(() => null);
        if (settled) throw new SkillError("MARKET_SETTLED", `Market ${args.market} has already settled.`, { data: { yesPayout: settled.settleFraction } });
        throw new SkillError("MARKET_NOT_FOUND", `No live market with id ${args.market}.`, { hint: "Find the id with markets.mjs --query <words>." });
      }
      if (market.isFallback) {
        throw new SkillError("MARKET_NOT_TRADABLE", "This is a question's fallback outcome; it has no order book.");
      }
      const sideIndex = resolveSideIndex(args.outcome, market.sides);
      const coin = market.sides[sideIndex].coin;

      const agent = await signerMod.agentKey({
        label: AGENT_KEY_LABEL,
        rotate: false,
        create: false,
        idempotencyKey,
        deadline: scriptDeadline(),
      });
      const health = requireValidAgent(await agentHealth(main, agent?.address ?? null));

      const hl = await readHlBalances(main);
      if (side === "buy" && hl.spotUsdcFree < order.notional) {
        throw new SkillError("NEEDS_SPOT", `Spot USDC is $${hl.spotUsdcFree}; this order needs $${order.notional}.`, {
          hint: hl.unified ? "Run deposit.mjs (unified account: no transfer needed, just funds)." : `Run ensure_spot.mjs --amount ${ceilCents(order.notional)}.`,
          status: "needs_spot",
          data: { spotUsdcFree: hl.spotUsdcFree, need: order.notional },
        });
      }
      if (side === "sell") {
        const held = hl.spotBalances.find((b) => b.coin === `+${coin.slice(1)}`);
        const free = Number(held?.total ?? 0) - Number(held?.hold ?? 0);
        if (free < order.size) {
          throw new SkillError("INSUFFICIENT_SHARES", `You hold ${free} free shares of this side; selling ${order.size}.`, {
            hint: "Check account.mjs; cancel resting sells first if shares are on hold.",
          });
        }
      }

      const trap = pendingTrap();
      await hip4.auth.initAuth(main, hip4AgentSigner(agent, trap));
      const res = await hip4.trading.placeOrder({
        marketId: args.market,
        outcome: coin,
        side,
        type: "limit",
        price: args.price,
        amount: String(order.size),
        timeInForce: tif,
      });
      trap.check(agent); // hip4 folds signer errors into the result; an owner wait must surface

      const summary = {
        marketId: args.market,
        market: market.parsedName ?? market.name,
        outcome: sideIndex === 0 ? "YES" : "NO",
        sideName: market.sides[sideIndex].parsedName ?? market.sides[sideIndex].name,
        coin,
        side,
        size: order.size,
        price: args.price,
        notional: order.notional,
        tif,
        agentHealth: health.code,
        idempotencyKey,
      };
      if (res.success) {
        return okEnvelope("done", { ...summary, orderId: res.orderId ?? null, orderStatus: res.status ?? null, filledShares: res.shares ?? null });
      }
      throw placeOrderFailure(res, summary);
    } finally {
      hip4.destroy();
    }
});
