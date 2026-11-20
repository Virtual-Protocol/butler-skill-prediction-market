# Hyperliquid: funding, spot vs perps, and the trading key

Background for answering your owner's questions. The scripts hold every constant
(contract addresses, token ids, chain ids); never type one into a command.

## Accounts

- A Hyperliquid account is an EVM address. Here it is the **main wallet**: the owner's
  Butler wallet in Main Chat, or the duty's own wallet inside a duty that has one.
  `status.mjs` prints it as `mainWallet`. Reads always use this address, never the trading
  key's.
- `hyperliquid.role` from `status.mjs`: `user` = active account, `missing` = this address
  has never deposited. Hyperliquid refuses every action (including approving a trading
  key) from a `missing` address with "Must deposit before performing actions".

## Perps vs spot, unified accounts

- In the standard mode (`abstraction` `default` or `disabled`), perps margin and the spot
  balance are separate. A deposit usually lands in **perps** (`perpsWithdrawable`).
- **Outcome orders spend spot USDC** (`spotUsdcFree` = spot total minus `spotUsdcHold`,
  the part locked in open orders). So in standard mode money must move perps → spot before
  a bet: `ensure_spot.mjs` does that.
- In **unified** mode (`unifiedAccount` or `portfolioMargin`, `unified: true`) there is one
  balance and it shows as spot. `ensure_spot.mjs` then moves nothing (`moved: 0`);
  Hyperliquid would refuse a transfer anyway ("Action disabled when unified account is
  active" → `UNIFIED_ACCOUNT`).
- This skill **never changes the account mode** (it affects the owner's whole Hyperliquid
  account, perps trading included). If your owner asks, they can switch it themselves in
  Hyperliquid's settings.

## Deposit (Arbitrum → Hyperliquid), `deposit.mjs`

| Fact | Value |
| --- | --- |
| How | One plain ERC-20 transfer of **native USDC on Arbitrum One** from the main wallet to Hyperliquid's Bridge2 contract (0x2df1…3df7). Hyperliquid credits the **sending** address. |
| Token | Native USDC (0xaf88…5831, 6 decimals). **Never USDC.e** (bridged): it is not credited. |
| Minimum | **5 USDC. Less is never credited and is lost.** The script refuses it (`AMOUNT_BELOW_MINIMUM`). |
| Gas | Production: bevo-server's paymaster takes Arbitrum gas in USDC, so keep amount + 0.5 USDC (`NEEDS_HEADROOM`). Dev signer: the wallet pays ETH (`NEEDS_GAS`). |
| Credit time | Usually under a minute. |
| Confirmation | Within its ~110 s budget the script waits briefly for the Arbitrum receipt, then checks Hyperliquid: a `deposit` row of the same amount in the account ledger (`userNonFundingLedgerUpdates`), or spot + perps rising by the amount. Otherwise `deposit_pending`. |
| Not credited yet | `deposit_pending` with a resume command: run that later. It re-checks under the same key and never sends again. |
| Bridge status | Hyperliquid marks Bridge2 "legacy" in favour of CCTP, but it still credits deposits. |

If the main wallet has too little USDC on Arbitrum (`INSUFFICIENT_USDC`, or status says
`arbitrumUsdcEnough: false`), your owner must send native USDC on Arbitrum to `mainWallet`
first.

## Withdraw (Hyperliquid → Arbitrum), `withdraw.mjs`

| Fact | Value |
| --- | --- |
| How | Hyperliquid's `withdraw3` action, signed by the **main wallet** (EIP-712 `HyperliquidTransaction:Withdraw`, Arbitrum chain id). The trading key can never sign it. |
| Destination | Always the signing wallet itself. The script has no destination flag and the signer refuses any other address. |
| Source | The **perps** balance (`perpsWithdrawable`); on a unified account the one balance. A standard account with money in spot first needs `ensure_perps.mjs`. USDC locked in open orders cannot leave. |
| Minimum and fee | 2 USDC minimum, flat 1 USDC fee taken from the amount (to be confirmed by a live test). |
| Arrival | About 5 minutes. Hyperliquid's ledger (`userNonFundingLedgerUpdates`) shows a `withdraw` row carrying the request's nonce at once; the USDC then shows on Arbitrum. |
| Nonce | The request's `time` is the nonce and is saved before signing, so `--resume` rebuilds the same request and checks the ledger by nonce before sending anything. |

## Moving spot → perps, `ensure_perps.mjs`

The mirror of `ensure_spot.mjs`: the same trading-key `agentSendAsset` into the same
account, source dex `spot`, destination dex `""` (perps). It moves only the gap needed for
a withdrawal and nothing on a unified account.

## Moving perps → spot, `ensure_spot.mjs`

- Uses Hyperliquid's `agentSendAsset`: an action the **trading key** may sign that moves
  USDC between the account's own balances (perps dex `""` → `spot`). The destination must be
  the same account, so the key cannot send money anywhere else.
- Moves only the gap: `ceil-to-cents(amount − spotUsdcFree)`. Needs that much in
  `perpsWithdrawable`, else `NEEDS_DEPOSIT`.
- Main Chat: one authorization card. A live duty: automatic.

## The trading key (Hyperliquid "agent" / API wallet)

- **What it is**: a separate key, held by Butler's server (never shown to you), that the
  main wallet approves once by signing Hyperliquid's `ApproveAgent` message. After that
  it signs orders, cancels and same-account perps→spot moves.
- **What it can never do**: withdraw, send USDC or tokens to another address, approve
  another key, or change the account mode. Those need the main wallet. Note: a key can
  still lose value through bad trades, which is why every order needs the owner's choice.
- **Names and slots**: an account has up to 3 named agents (plus 1 unnamed). This skill's
  key is named `Butler`; approving a new key under the same name **replaces** the old one
  (that is how rotation works). `status.mjs` lists all of them in `allAgents`.
- **Expiry**: approvals lapse. Observed on mainnet: about **90 days** after signing, even
  with no explicit expiry (the cap is 180 days). Renewal is routine, not an error.
- **It also stops working when**: another key is approved under the same name, or the
  account is emptied (Hyperliquid prunes agents of an account with no funds).
- **Never re-approve an old key address.** After pruning, its nonce history may be gone and
  old signatures could be replayed. `setup_agent.mjs --rotate` always makes a fresh key.
- **How validity is decided** (only by the scripts, never by guessing):

| Signal | Result |
| --- | --- |
| `extraAgents(mainWallet)` lists the key, expiry in the future or none | valid (`AGENT_OK`) |
| listed, < 14 days left | valid but `AGENT_EXPIRING` (warn, ask) |
| listed, < 7 days left | `mustRotate` (status says `needs_agent`) |
| not listed, or expiry passed | `AGENT_INVALID` |
| `userRole(key)` is not `agent` of `mainWallet` | `AGENT_INVALID` |
| an order or cancel answered "User or API Wallet ... does not exist" | `AGENT_INVALID` |
| any other exchange error | `EXCHANGE_ERROR`: not a key problem until `status.mjs` says so |

- **Rotation** (`setup_agent.mjs --rotate`): the server creates a fresh key and replaces the
  stored one at once, the main wallet signs ApproveAgent (signature card in Main Chat), the
  script submits it and waits until Hyperliquid lists the new key. Because the old key is
  gone the moment rotation starts, renewing a still-valid key needs your owner's yes first.

## Nonces (why some steps cannot be resumed)

- Every Hyperliquid action carries a millisecond nonce. Each signer keeps its 100 highest
  nonces; a new one must be higher than the lowest of them, never reused, and within about
  (now − 2 days, now + 1 day). Main-wallet and trading-key actions have separate nonce sets.
- ApproveAgent's nonce is fixed when the card is filed and saved with the pending step, so
  `setup_agent.mjs --resume` can submit the owner's signature later (it stays valid for
  about 2 days). A withdrawal works the same way: its `time` is the nonce.
- Orders, cancels and perps→spot moves get their nonce inside the SDK at signing time, so a
  timed-out authorization cannot be resumed: it must be asked again (a new card, new key).

## Reads the scripts use (Hyperliquid info API)

`spotClearinghouseState` (spot balances, outcome shares as `+…` rows), `clearinghouseState`
(perps `withdrawable`), `userAbstraction` (mode), `userRole` (`missing`, `user`, `agent`),
`extraAgents` (approved keys with `validUntil`), `userNonFundingLedgerUpdates` (deposits and
withdrawals).
Hyperliquid answers errors in free text with HTTP 200; the scripts map the known ones to
codes (see `commands.md`).
