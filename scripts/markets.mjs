#!/usr/bin/env node
// Read-only. List HIP-4 outcome markets (all types, including labelledBinary
// template markets) or show one market with its order books.
//
//   node markets.mjs [--query "btc above"] [--venue out|all|<venue>] [--type <type>] [--limit 30]
//   (default --venue out = Outcome.xyz's own markets; --venue all = every HIP-4 deployer)
//   node markets.mjs --id <marketId>
//
// marketId = the outcomeId string. Outcome.xyz's own markets have venue "out".

import { runScript, parseArgs, okEnvelope, createHip4, SkillError } from "./lib/common.mjs";

const TYPES = new Set(["defaultBinary", "labelledBinary", "multiOutcome", "priceBucket"]);

runScript(async () => {
  const args = parseArgs(process.argv.slice(2), {
    query: { type: "string" },
    id: { type: "string" },
    venue: { type: "string" },
    type: { type: "string" },
    limit: { type: "string" },
  });
  const venue = args.venue ?? "out";
  if (args.type && !TYPES.has(args.type)) throw new SkillError("BAD_ARGS", `--type must be one of ${[...TYPES].join(", ")}`);
  const limit = args.limit ? Number(args.limit) : 30;
  if (!Number.isInteger(limit) || limit <= 0) throw new SkillError("BAD_ARGS", "--limit must be a positive integer");
  if (args.id && !/^\d+$/.test(args.id)) throw new SkillError("BAD_ARGS", "--id must be a numeric market id (outcomeId)");

  const hip4 = await createHip4();
  try {
    const sdk = await import("@outcome.xyz/hip4");
    const [markets, mids] = await Promise.all([
      hip4.events.fetchMarkets({ sortBy: "volume" }),
      hip4.client.fetchAllMids(),
    ]);
    const all = Array.isArray(markets) ? markets : [];

    if (args.id) {
      const m = all.find((x) => String(x.outcomeId) === args.id);
      if (!m) {
        const settled = await hip4.client.fetchSettledOutcome(Number(args.id));
        if (settled) {
          return okEnvelope("done", {
            market: { id: args.id, settled: true, settleFraction: settled.settleFraction, details: settled.details, name: settled.spec?.name },
          });
        }
        throw new SkillError("MARKET_NOT_FOUND", `No live or settled market with id ${args.id}.`, { hint: "Search with markets.mjs --query <words>." });
      }
      const books = await Promise.all([0, 1].map((side) => hip4.marketData.fetchOrderBook(args.id, side).catch(() => null)));
      const row = toRow(m, mids, sdk);
      row.sides.forEach((s, i) => {
        const b = books[i];
        s.bestBid = b?.bids?.[0]?.price ?? null;
        s.bestAsk = b?.asks?.[0]?.price ?? null;
        s.book = b ? { bids: b.bids.slice(0, 5), asks: b.asks.slice(0, 5) } : null;
      });
      return okEnvelope("done", { market: row });
    }

    let rows = all.filter((m) => !m.isFallback);
    if (venue !== "all") rows = rows.filter((m) => (m.raw?.venue ?? "") === venue);
    if (args.type) rows = rows.filter((m) => m.type === args.type);
    if (args.query) {
      const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      rows = rows.filter((m) => {
        const hay = searchText(m).toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const counts = {};
    for (const m of all) counts[m.type] = (counts[m.type] ?? 0) + 1;
    return okEnvelope("done", {
      venue,
      total: rows.length,
      shown: Math.min(limit, rows.length),
      catalogCounts: counts,
      markets: rows.slice(0, limit).map((m) => toRow(m, mids, sdk)),
    });
  } finally {
    hip4.destroy();
  }
});

function searchText(m) {
  return [
    m.parsedName,
    m.name,
    m.description,
    m.parsedQuestionName,
    m.questionName,
    ...m.sides.map((s) => s.parsedName ?? s.name),
  ]
    .filter(Boolean)
    .join(" ");
}

function toRow(m, mids, sdk) {
  // Template parameters live in key:value descriptions; multi-outcome markets keep the time on the question.
  const params = {
    ...(m.questionDescription ? safe(() => sdk.parseInstanceDescription(m.questionDescription)) ?? {} : {}),
    ...(safe(() => sdk.parseInstanceDescription(m.raw?.description ?? m.description)) ?? {}),
  };
  const eventAt = m.expiry ?? safe(() => sdk.eventAtFrom(params));
  return {
    id: String(m.outcomeId),
    type: m.type,
    venue: m.raw?.venue ?? null,
    outcomeOwn: m.raw?.venue === "out",
    name: m.parsedName ?? m.name,
    question: m.parsedQuestionName ?? m.questionName ?? null,
    expiry: eventAt ? new Date(eventAt).toISOString() : null,
    underlying: m.underlying ?? safe(() => sdk.perpFrom(params)) ?? null,
    threshold: m.targetPrice != null ? String(m.targetPrice) : safe(() => sdk.thresholdFrom(params)) ?? null,
    bucket: m.type === "priceBucket" ? { lower: m.lowerBound, upper: m.upperBound } : undefined,
    sides: m.sides.map((s, i) => ({
      outcome: i === 0 ? "YES" : "NO",
      name: s.parsedName ?? s.name,
      coin: s.coin,
      mid: mids?.[s.coin] ?? null,
    })),
  };
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
