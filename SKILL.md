---
name: prediction-market
description: "Bet on Outcome.xyz prediction markets (Hyperliquid HIP-4): find markets, fund or withdraw from Hyperliquid, set up the trading key, place or cancel limit orders, read positions. Runs scripts."
version: 1.2.0
metadata: {"butler":{"moneyMoving":true,"keywords":["prediction market","outcome","outcome.xyz","HIP-4","hyperliquid prediction","bet on","buy yes","buy no","sell prediction","prediction positions","prediction balance","cancel prediction order","deposit hyperliquid","withdraw from hyperliquid","withdraw prediction","trading key"],"requires":{"bins":["bevo-wallet","node","npm"]}}}
---

## When to use

Your owner wants Outcome.xyz (Hyperliquid HIP-4 outcome markets): find a market ("any BTC
markets?"), check positions or settled bets, bet ("40 shares of Yes at 47¢"), sell or
cancel, withdraw to their own wallet. Not this skill: Hyperliquid perps, Polymarket,
or sending money to anyone else.

You only run this skill's scripts. Never write your own SDK code, never call Hyperliquid
yourself, never handle a key. Each script prints ONE JSON object
`{ok, status, data, error:{code,message,hint}}`: act on `status` and `error.code`.
Figures come only from this turn's script output.

## Before you start

**Install once.** Needs Node 22.12+. This checks and installs only when missing:

```sh
cd "${BEVO_SKILLS_DIR:-$HOME/skills}/prediction-market" && { npm ls --depth=0 >/dev/null 2>&1 || npm ci --omit=dev --ignore-scripts --no-audit --no-fund; }
```

If it fails, say the tools cannot install now; stop.
Scripts live at `${BEVO_SKILLS_DIR:-$HOME/skills}/prediction-market/scripts/`; write that
path out in full in every command. The scripts: `scripts/status.mjs`,
`scripts/markets.mjs`, `scripts/account.mjs`, `scripts/setup_agent.mjs`,
`scripts/deposit.mjs`, `scripts/ensure_spot.mjs`, `scripts/ensure_perps.mjs`,
`scripts/withdraw.mjs`, `scripts/place_bet.mjs`, `scripts/cancel.mjs`.

**Which wallet.** Scripts never name one. A duty with its own wallet uses it; anywhere else
it is the owner's main wallet and every signature is a card. `walletScope` says which.
**Always file a duty for this skill with its own wallet and `autoExecute: true`**, or its
steps are cards too. One errand, one wallet.

**Cards.** Main-wallet steps file a **signature card**: `deposit.mjs`,
`setup_agent.mjs`, `withdraw.mjs`. Trading-key steps file an **authorization card**:
`ensure_spot.mjs`, `ensure_perps.mjs`, `place_bet.mjs`, `cancel.mjs`. The script waits
~1.5 min for the tap, so tell your owner BEFORE you run it ("approve it within a minute").

**The trading key** (a Hyperliquid "agent", name `Butler`) is approved by the main wallet,
can trade and move USDC between the account's own perps and spot, and can never withdraw.
Approvals lapse after ~90 days, or sooner if replaced or the account empties.
Depth: `references/outcome-sdk.md`, `references/hyperliquid-sdk.md`, `references/commands.md`.

### Never place an order unless

1. Your owner chose market, side (YES/NO), buy/sell, shares and price, in this chat.
2. It is a **limit** order: whole shares, price 0.00001–0.99999, shares × price ≥ $2.
3. You told them the cost and the loss case, then ran it once.

## Procedure

1. [FIXED] **Status first, every errand.** Pass the order cost as `--need`:

   ```sh
   node "${BEVO_SKILLS_DIR:-$HOME/skills}/prediction-market/scripts/status.mjs" --need 20
   ```

   Act on `data.next.status`:

   | `next.status` | Do |
   | --- | --- |
   | `needs_deposit` | step 2 with at least `next.suggestedDepositUsdc`. `arbitrumUsdcEnough: false` → ask your owner to send native USDC on Arbitrum to `mainWallet`; stop. |
   | `needs_agent` | step 3; `--rotate` when `next.rotate` is true. |
   | `needs_spot` | step 4 with `next.suggestedSpotAmount`. |
   | `ready` | step 5. If `next.code` is `AGENT_EXPIRING`, first tell your owner the key expires in `agent.daysLeft` days and ask to renew now (step 3 `--rotate`). |

   After steps 2–4, run status again.

2. [FIXED] **Deposit** (Arbitrum USDC → Hyperliquid, ≥ 5 USDC; less is lost):

   ```sh
   node "${BEVO_SKILLS_DIR:-$HOME/skills}/prediction-market/scripts/deposit.mjs" --amount 5 --idempotency-key pm-dep-20261119-1030
   ```

   `done` → credited. `deposit_pending` → sent: run status.mjs in a minute; never
   deposit again (`data.resume` only re-checks). Keep 0.5 USDC above the
   amount on Arbitrum: gas is paid in USDC.

3. [FIXED] **Set up or renew the trading key** (needs a prior deposit):

   ```sh
   node "${BEVO_SKILLS_DIR:-$HOME/skills}/prediction-market/scripts/setup_agent.mjs" --idempotency-key pm-key-20261119-1031
   node "${BEVO_SKILLS_DIR:-$HOME/skills}/prediction-market/scripts/setup_agent.mjs" --rotate --idempotency-key pm-key-20261119-1031
   ```

   Run ONE. Plain: first setup, or to confirm a key (`alreadyApproved: true` → nothing was
   signed). `--rotate` replaces the old key at once: use it for `AGENT_INVALID` on an
   existing key, `next.rotate: true`, or a renewal your owner agreed to.

4. [FIXED] **Spot USDC** (bets spend spot; moves only the gap from perps):

   ```sh
   node "${BEVO_SKILLS_DIR:-$HOME/skills}/prediction-market/scripts/ensure_spot.mjs" --amount 20 --idempotency-key pm-spot-20261119-1032
   ```

5. [ADAPT] **Find the market and price.** Search 1–2 plain words (all must match);
   `--venue out` (default, Outcome's own), `--venue all` if nothing fits:

   ```sh
   node "${BEVO_SKILLS_DIR:-$HOME/skills}/prediction-market/scripts/markets.mjs" --venue out --query btc
   node "${BEVO_SKILLS_DIR:-$HOME/skills}/prediction-market/scripts/markets.mjs" --id 37348
   ```

   `--id` gives `sides[].bestBid` / `bestAsk`. Shares = floor(budget ÷ price), at least
   ceil(2 ÷ price). Settled → say so.

6. [FIXED] **Place one limit order** (`--outcome YES|NO`, `--side buy|sell`):

   ```sh
   node "${BEVO_SKILLS_DIR:-$HOME/skills}/prediction-market/scripts/place_bet.mjs" --market 37348 --outcome YES --side buy --size 40 --price 0.47 --idempotency-key pm-bet-20261119-1033
   ```

   Fill now: price = best ask (buy) / best bid (sell) plus `--tif FAK`. Default GTC rests. Selling: `account.mjs` must show the shares.
   `done` → report `orderStatus` (`filled` + `filledShares`, or `resting` + `orderId`).

7. [FIXED] **Cancel** one order (id from `account.mjs`); `--all` instead cancels every one:

   ```sh
   node "${BEVO_SKILLS_DIR:-$HOME/skills}/prediction-market/scripts/cancel.mjs" --order-id 123456789 --idempotency-key pm-cxl-20261119-1034
   ```

8. [ADAPT] **Account** (positions, open orders, fills, settled, read any time):

   ```sh
   node "${BEVO_SKILLS_DIR:-$HOME/skills}/prediction-market/scripts/account.mjs" --days 7
   ```

   Winners redeem automatically: no claim step. `settled[].yesPayout` is what one YES share
   paid; NO paid 1 minus that.

9. [FIXED] **Withdraw** (to the SAME wallet on Arbitrum, ≥ 2 USDC, $1 fee; no destination
   flag). Run status first. Use `--all` for everything:

   ```sh
   node "${BEVO_SKILLS_DIR:-$HOME/skills}/prediction-market/scripts/withdraw.mjs" --amount 20 --idempotency-key pm-wd-20261119-1036
   ```

   `withdraw_pending` → sent; lands in ~5 minutes. `needs_perps` → `ensure_perps.mjs
   --amount <data.amountUsdc> --idempotency-key pm-perps-…`, then withdraw again. Money in open
   orders cannot leave: cancel first. In a duty, before deleting it, run status until the
   USDC shows on Arbitrum.

### Agent-key validity (status `data.agent.code`)

| Code | Meaning | Do |
| --- | --- | --- |
| `AGENT_OK` | approved | trade |
| `AGENT_EXPIRING`, < 14 days | still valid | warn and ask; renew only on their yes |
| `AGENT_EXPIRING` + `mustRotate` (< 7 days) | must renew | `needs_agent`: tell them, step 3 `--rotate` |
| `AGENT_INVALID` | expired, replaced, pruned or none | step 3 (`--rotate` if a key existed), then retry the failed command ONCE with a new key |

Only these codes mean the key is bad. For `EXCHANGE_ERROR` or anything unknown run status
first; never rotate blindly or re-approve an old key address.

## Idempotency and retries

Money steps REFUSE to run without `--idempotency-key` (`IDEMPOTENCY_KEY_REQUIRED`). Use
a new one for every new ask: `pm-<step>-<YYYYMMDD-HHMM>` (1–120 of letters, digits, `:_.-`).
Every output echoes it as `idempotencyKey`. A money step (any script but the reads) whose
outcome is unknown (timeout, cut off with no JSON, `ORDER_UNKNOWN`, `UNEXPECTED`): do not
re-run it with a new key. First read: status.mjs, account.mjs.

- `pending_owner_signature` (deposit, setup_agent, withdraw): the card is waiting; once
  your owner says they signed, run exactly `data.resume` (same key, `--resume`).
- Cut off with no JSON during those three: the same command plus `--resume <your key>`.
- `authorization_timeout` (ensure_spot, ensure_perps, place_bet, cancel): nothing ran, not
  resumable. Ask if they still want it; if yes, run it again with a NEW key (a new card).
- Duties pass their slot key, so a re-fire is refused (`KEY_REUSED`), not doubled.
- Orders go one at a time, never in parallel.

## Failure handling

| `error.code` | Do |
| --- | --- |
| `BAD_ARGS` | fix the flags; never invent flags |
| `AMOUNT_BELOW_MINIMUM` | deposit at least 5 USDC; withdraw at least 2 |
| `INSUFFICIENT_USDC` | owner sends native USDC (not USDC.e) on Arbitrum to `mainWallet` |
| `NEEDS_HEADROOM` | gas is paid in USDC: deposit the hint's smaller amount (≥ 5), or the owner adds USDC |
| `DEPOSIT_TX_FAILED` | nothing reached Hyperliquid; tell your owner |
| `NEEDS_DEPOSIT` | step 2 |
| `AGENT_INVALID` | agent-key table |
| `APPROVE_FAILED` | report `data.raw`; run status; no auto-retry |
| `AGENT_APPROVAL_UNCONFIRMED` | wait a minute, run status; if the key shows, rerun step 3 plain |
| `NEEDS_SPOT` | step 4 with the amount in the hint |
| `INSUFFICIENT_HL_BALANCE` / `NOTHING_TO_WITHDRAW` | withdraw at most the hint's amount, or say it is empty |
| `WITHDRAW_REFUSED` / `SIGN_TYPE_REFUSED` | nothing left; report the message |
| `WITHDRAW_ALREADY_SUBMITTED` | already sent: never again; run status |
| `WITHDRAW_UNKNOWN` | same command plus `--resume <key>`; never a new key |
| `INSUFFICIENT_BALANCE` | run status; step 4 or 2 (`UNIFIED_ACCOUNT`: no transfer needed) |
| `MARKET_ORDER_REFUSED` | add `--price` (limit only) |
| `ORDER_BELOW_MINIMUM` | raise shares to the hint's count |
| `BAD_PRICE` | ≤ 5 decimals, strictly between 0 and 1 |
| `INSUFFICIENT_SHARES` | sell at most the free shares `account.mjs` shows |
| `MARKET_NOT_FOUND` / `MARKET_SETTLED` / `MARKET_NOT_TRADABLE` | say so; search again |
| `ORDER_INVALID` | nothing was sent; fix and ask your owner |
| `ORDER_UNKNOWN` | do not retry; run account.mjs for the order or a fill |
| `ORDER_NOT_FOUND` | already filled or cancelled |
| `EXCHANGE_ERROR` | run status first; report the message |
| `HL_UNREACHABLE` / `HL_INFO_FAILED` | retry once in a minute, then say so |
| `RESUME_NOT_FOUND` / `RESUME_MISMATCH` | the step finished or changed; run status |
| `KEY_REUSED` | this key already ran; read status/account first |
| `IDEMPOTENCY_KEY_REQUIRED` | add `--idempotency-key` |
| `OWNER_DECLINED` | card rejected or expired; nothing ran. Ask; retry only with a NEW key |
| `SIGNER_OUTDATED` | the container runs an old build: tell the owner it must be redeployed; stop |
| `DUTY_DELETED` | duty deleted; nothing ran. Stop |
| `DEV_CAP_EXCEEDED` / `SIGNER_NOT_CONFIGURED` / `UNEXPECTED` | report; run status (and account) before anything |

## Limits

- Outcome.xyz / HIP-4 on Hyperliquid mainnet only. Limit orders only, whole shares, $2
  minimum per order (sells too: a smaller position waits for settlement).
- Deposit ≥ 5 USDC, native USDC on Arbitrum only. Withdraw ≥ 2 USDC, only to the same
  wallet. No account-mode change.
- A share pays $1 if its side wins, $0 if not.

## Say to the owner

Use your owner's language.
- Before a buy: "'BTC touches 60000 by Dec 1': YES at 47¢. 40 shares cost ~$18.80; if YES
  does not happen, it is lost. A card will appear: approve it."
- Card waiting: "Approve the card in your app; I'll finish as soon as you do." Expired:
  "The card expired, so nothing ran. Want me to send it again?"
- Key expiring or lapsed: "Your trading permission on Hyperliquid expires in 5 days (or lapsed). Renew now? It's one signature."
- Deposit pending: "Your 5 USDC is on its way; I'll check."
- Withdrawal: "Withdraw 20 USDC to your wallet on Arbitrum? A $1 fee applies, so 19 USDC
  arrives in about 5 minutes. A card will appear: approve it."
- Never show a key, approval id or raw JSON.
