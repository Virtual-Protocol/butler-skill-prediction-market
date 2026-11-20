#!/usr/bin/env node
// Read-only. Outcome positions, open outcome orders, recent outcome fills and
// how recently traded markets settled.
//
//   node account.mjs [--days 7]
//   node account.mjs --address 0x...          (read-only override, no signer needed)
//
// Settlement is read with client.fetchSettledOutcome (event status is almost
// always "active" and cannot be trusted). Winning shares auto-redeem to USDC.

import { runScript, parseArgs, okEnvelope, loadSigner, createHip4, readHlBalances, settledNames, SkillError } from "./lib/common.mjs";

const MAX_SETTLED_LOOKUPS = 15;

runScript(async () => {
  const args = parseArgs(process.argv.slice(2), {
    address: { type: "string" },
    days: { type: "string" },
  });
  const days = args.days ? Number(args.days) : 7;
  if (!(days > 0 && days <= 30)) throw new SkillError("BAD_ARGS", "--days must be between 1 and 30");

  let main = args.address;
  let walletScope = null;
  if (main) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(main)) throw new SkillError("BAD_ARGS", "--address is not an address");
  } else {
    const signerMod = await loadSigner();
    const signer = await signerMod.mainSigner({});
    main = signer.address;
    walletScope = signer.walletScope ?? null;
  }

  const hip4 = await createHip4();
  try {
    const { parseSideCoin, classifyOutcome } = await import("@outcome.xyz/hip4");
    const now = Date.now();
    const [markets, positions, openOrders, fills, hl] = await Promise.all([
      hip4.events.fetchMarkets(),
      hip4.account.fetchPositions(main),
      hip4.account.fetchOpenOrders(main),
      hip4.client.fetchUserFillsByTime(main, now - days * 86_400_000, now),
      readHlBalances(main),
    ]);

    const byCoin = new Map();
    for (const m of Array.isArray(markets) ? markets : []) {
      m.sides.forEach((s, i) =>
        byCoin.set(s.coin, { marketId: String(m.outcomeId), market: m.parsedName ?? m.name, question: m.parsedQuestionName ?? null, outcome: i === 0 ? "YES" : "NO", side: s.parsedName ?? s.name }),
      );
    }
    const isOutcomeCoin = (coin) => /^[#+]\d+$/.test(coin ?? "") && parseSideCoin(coin) !== null;
    const describe = (coin) => {
      const p = parseSideCoin(coin);
      const hash = `#${coin.slice(1)}`;
      return byCoin.get(hash) ?? { marketId: p ? String(p.outcomeId) : null, market: null, outcome: p?.sideIndex === 0 ? "YES" : "NO", side: null };
    };

    const outcomeOrders = openOrders
      .filter((o) => isOutcomeCoin(o.coin))
      .map((o) => ({ orderId: String(o.oid), coin: o.coin, ...describe(o.coin), side: o.side === "B" ? "buy" : "sell", price: o.limitPx, size: o.sz, placedAt: new Date(o.timestamp).toISOString() }));

    const outcomeFills = fills
      .filter((f) => isOutcomeCoin(f.coin))
      .sort((a, b) => b.time - a.time)
      .map((f) => ({ coin: f.coin, ...describe(f.coin), side: f.side === "B" ? "buy" : "sell", price: f.px, size: f.sz, fee: f.fee, orderId: String(f.oid), time: new Date(f.time).toISOString() }));

    // Settlement check for markets we traded or hold that are no longer listed live.
    const ids = new Set();
    for (const f of outcomeFills) if (f.marketId && !byCoin.has(`#${f.coin.slice(1)}`)) ids.add(f.marketId);
    for (const p of positions) if (!byCoin.has(`#${String(p.outcome).slice(1)}`)) ids.add(p.marketId);
    const settled = [];
    let templates = null;
    for (const id of [...ids].slice(0, MAX_SETTLED_LOOKUPS)) {
      const s = await hip4.client.fetchSettledOutcome(Number(id)).catch(() => null);
      if (!s) continue;
      templates ??= await hip4.client.fetchOutcomeTemplates().catch(() => []);
      const names = settledNames(s, templates, classifyOutcome);
      settled.push({ marketId: id, name: names.name, question: names.question, yesPayout: s.settleFraction });
    }
    for (const f of outcomeFills) {
      const st = !f.market && settled.find((x) => x.marketId === f.marketId);
      if (st) Object.assign(f, { market: st.name, question: st.question, settled: true });
    }

    return okEnvelope("done", {
      mainWallet: main,
      walletScope,
      spotUsdcFree: hl.spotUsdcFree,
      spotUsdcHold: hl.spotUsdcHold,
      positions: positions.map((p) => ({
        marketId: p.marketId,
        market: p.parsedMarketQuestion || p.marketQuestion || describe(p.outcome).market,
        outcome: describe(p.outcome).outcome,
        side: p.parsedOutcomeName || p.outcomeName,
        coin: `#${String(p.outcome).slice(1)}`,
        shares: p.shares,
        avgCost: p.avgCost,
        currentPrice: p.currentPrice,
        unrealizedPnl: p.unrealizedPnl,
        payoutIfWins: p.potentialPayout,
      })),
      openOrders: outcomeOrders,
      recentFills: outcomeFills.slice(0, 20),
      settled,
    });
  } finally {
    hip4.destroy();
  }
});

