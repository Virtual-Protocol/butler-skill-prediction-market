# Outcome.xyz and the HIP-4 SDK

Background for answering your owner's questions. You never call the SDK yourself: the
scripts do, with `@outcome.xyz/hip4` pinned at **1.3.0** (mainnet, `testnet: false`) and
`@nktkas/hyperliquid` 0.33.3, both locked by `package-lock.json`.

## What Outcome.xyz is

- **HIP-4** added "outcome" markets to Hyperliquid: fully collateralised binary contracts
  that settle to 0 or 1. Matching, custody and settlement all happen on Hyperliquid.
  Outcome.xyz is a front end and market deployer; there is no separate Outcome account:
  the owner's Hyperliquid account (the wallet address) is the account.
- Several deployers publish HIP-4 markets. Each has a `venue`; Outcome.xyz's own are
  **`out`** (others seen live: `skew`, `txyz`, `fox`, and protocol-run recurring markets
  with no venue). The scripts can trade any of them; default to `out` when the owner says
  "Outcome".
- Settlement currency is **USDC**. Orders spend the account's **spot** USDC. (The SDK
  still mentions USDH in places: that is legacy wording.)
- No leverage and no liquidation. Geo-restricted (US, some Canadian provinces, sanctioned
  regions): if your owner says they are there, say the venue does not serve them.

## Markets, sides, shares

- A **market** (an "outcome") has a numeric id (what `--market` / `--id` take) and exactly
  two **sides**: side 0 (shown as `YES`, or the first named alternative) and side 1 (`NO`).
  Each side is its own token; one YES plus one NO is always worth exactly $1.
- A **question** groups several markets where exactly one resolves YES (e.g. "Who wins the
  election?" with one market per candidate). Each candidate is its own YES/NO market. Every
  question has a **fallback** market ("Other") that has no order book; the scripts never
  list or trade it (`MARKET_NOT_TRADABLE`).
- Market types the scripts report: `labelledBinary` (most markets, including template
  markets such as "BTC touches 60000 by Dec 1, 00:00 UTC"), `defaultBinary` (protocol
  recurring price markets), `multiOutcome` (a question's candidates), `priceBucket`
  (a question split into price ranges). Names are always the readable ("parsed") form;
  `expiry`, `underlying` and `threshold` are parsed from the market's description.
- **Price** is the probability, quoted per share: buying YES at 0.47 costs $0.47 a share
  and pays $1.00 if YES wins, $0 if it loses. The YES and NO books are one merged book: a
  YES bid at 0.71 is a NO ask at 0.29, so the two mids add up to about 1.
- **Size is always in shares**, for buys and sells. There is no "spend $X" order. To spend
  about $X: shares = floor(X ÷ price). Shares are whole numbers.
- **Notional** = shares × price. This skill's minimum is **$2** (Outcome.xyz's product
  minimum; the exchange itself accepts $1). So the minimum shares = ceil(2 ÷ price), e.g.
  5 at 0.47, 20 at 0.10.
- **Tick**: 0.00001 (at most 5 decimals); valid prices 0.00001 to 0.99999.
- `mid` in the scripts' output is the midpoint, not what you pay. What you pay now is the
  best ask (buy) and what you get now is the best bid (sell): `markets.mjs --id <id>`.

## Orders

- Fills happen at the resting order's price; partial fills are normal; cancelling is free;
  a fill that races a cancel wins.
- Time in force: `GTC` rests until filled or cancelled; `FAK` (immediate-or-cancel) fills
  what it can now and cancels the rest; `ALO` is post-only.
- **Market orders are refused by `place_bet.mjs`**: the SDK sends them at 0.99999 (buy) or
  0.00001 (sell), i.e. with no slippage limit. To fill now, send a limit at the best ask or
  bid with `--tif FAK`.
- Orders from one trading key must go one at a time: the SDK uses the millisecond clock as
  the action nonce, so two orders in parallel can collide.
- An order result that is neither accepted nor rejected (network failure after sending)
  is `ORDER_UNKNOWN`: Hyperliquid may have it. There is no client order id, so the only way
  to know is `account.mjs` (open orders and fills).
- Fees: Hyperliquid's spot rates; Outcome.xyz currently charges no builder fee, and this
  skill attaches none.

## Resolution and settlement

- Price markets settle against Hyperliquid's perp mark price (UTC times). Event markets
  (sports, rates, listings) settle against the official source named in the market,
  normally within about 4 hours of the official result.
- At settlement, open orders are cancelled and winning shares are redeemed to USDC in the
  spot balance automatically, minus a small settlement fee. **There is no claim step.**
- `yesPayout` (`settleFraction`) is what one YES share paid: `1`, `0`, or a fraction (a
  draw in some sports markets pays 0.5 to both sides). One NO share paid 1 minus that.
- The SDK's market "status" is almost always `active` even after settlement, so the
  scripts check settlement separately (`fetchSettledOutcome`). A settled market disappears
  from the live list.

## What each script calls

| Script | SDK / API calls |
| --- | --- |
| `markets.mjs` | `events.fetchMarkets({sortBy:"volume"})`, `client.fetchAllMids()`, `marketData.fetchOrderBook(id, side)` for `--id`, `client.fetchSettledOutcome(id)`, `parseInstanceDescription` and friends for expiry/threshold |
| `account.mjs` | `account.fetchPositions`, `account.fetchOpenOrders`, `client.fetchUserFillsByTime`, `client.fetchSettledOutcome`, Hyperliquid `spotClearinghouseState` |
| `place_bet.mjs` | `events.fetchMarkets` (find the market and side coin), `auth.initAuth(mainWallet, tradingKey)`, `trading.placeOrder({marketId, outcome: coin, side, type:"limit", price, amount: shares, timeInForce})` |
| `cancel.mjs` | `account.fetchOpenOrders`, `parseSideCoin`, `trading.cancelOrder([{marketId, orderId, outcome}])` (the side coin is always passed, otherwise a NO order would not be cancelled) |
| `setup_agent.mjs` | `getAgentApprovalTypedData(agent, name, nonce, true)`, main-wallet signature, `submitAgentApproval(...)`, then Hyperliquid `extraAgents` until listed |
| `status.mjs`, `ensure_spot.mjs`, `deposit.mjs` | Hyperliquid info API and `@nktkas/hyperliquid` (see `hyperliquid-sdk.md`) |

## Coin names (when reading raw output)

- `#<marketId><side>` is a tradable side, e.g. `#373480` = market 37348, side 0 (YES).
- `+<marketId><side>` is the same side as it appears in balances and positions.
- The scripts already translate both into `marketId` and `YES`/`NO`.

## SDK gotchas the scripts already handle

- The adapter defaults to **testnet**; the scripts force mainnet.
- `placeOrder` never throws: failures come back in the result, so the scripts classify them
  (`ORDER_INVALID` before sending, `EXCHANGE_ERROR` family when Hyperliquid refused,
  `ORDER_UNKNOWN` when the answer was lost).
- The SDK's `agentStatus()` treats a key with no expiry as expired; the scripts use their
  own check (`extraAgents` plus `userRole`).
- `fetchSettledOutcome` lives on `hip4.client`, not on `hip4.events` as the README says.
