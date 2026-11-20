# Local dev signer

`dev/local-signer.mjs` implements the same contract as the container's `bevo-signer.mjs`
(`docs/plans/architect-review-agent-keys.md` §3), but signs locally from env vars. It lives
outside `scripts/`, so the hub never publishes it. Use it to run the skill scripts on mainnet
from a Mac before bevo-server/virtuals-agent support exists.

## Setup (Node >= 22.12; the container runs Node 24)

Dependencies live at the **skill root** (`package.json`, `package-lock.json`, `node_modules/`),
never under `scripts/` (Mastra scans `scripts/` recursively). Node resolves them upward.

```bash
cd butler-skills-suite/butler-skill-prediction-market   # or this worktree: the SKILL ROOT
npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Load the test wallet from bevo-server/.env without printing anything
set -a; source <(grep -E '^(OUTCOME_MAIN_WALLET|OUTCOME_AGENT_PRIVATE_KEY)=' \
  /Users/lisanaaa/Documents/virtuals_protocol/bevo-super-app/bevo-server/.env); set +a
export BEVO_SIGNER=$PWD/dev/local-signer.mjs
```

| Env | Needed for |
|---|---|
| `OUTCOME_MAIN_WALLET` | everything (main wallet address) |
| `OUTCOME_AGENT_PRIVATE_KEY` | an already-approved agent key; used by place_bet / cancel / ensure_spot |
| `DEV_MAIN_PRIVATE_KEY` | optional; only `deposit.mjs` and `setup_agent.mjs` need it. Without it they stop with `MAIN_SIGNER_UNAVAILABLE` |
| `DEV_AGENT_NAME` | HL agent name when `setup_agent.mjs` approves a NEW key (default `bevo-dev`). The test wallet already uses all 3 named slots, so use `DEV_AGENT_NAME=bevo` (replaces the dev agent, never `Butler`) |
| `ARBITRUM_RPC_URL` | default `https://arb1.arbitrum.io/rpc` |

Never echo these variables. Key precedence in `agentKey()`: `dev/.agent-key.json` (written by
`--rotate` or a first setup, mode 0600, gitignored) > `OUTCOME_AGENT_PRIVATE_KEY` > generate.
Delete `dev/.agent-key.json` to go back to the env key.

Dev-only safety: any single deposit, order or withdrawal over $10 is refused (`DEV_CAP_EXCEEDED`).
The dev main-wallet signer signs only `HyperliquidTransaction:ApproveAgent` and a
`HyperliquidTransaction:Withdraw` whose destination is its own address; any other
`HyperliquidTransaction:*` type, or a withdrawal to another address, is refused with
`SIGN_TYPE_REFUSED` (the production server enforces the same rule).
`sendTransaction` is idempotent per `${idempotencyKey}:${n}` (`dev/.ledger.json`, gitignored),
so `deposit.mjs --resume <key>` re-checks instead of sending twice.

## Signer contract (and the extensions this skill relies on)

```
mainSigner({ idempotencyKey })
  -> { address, walletScope: "duty" | "main", signTypedData(...) -> 0x, sendTransaction({chainId,to,data,value}) -> { hash|null, status } }
agentKey({ label, rotate, idempotencyKey, create })
  -> { id, label, address, signerWallet, approved, generated, getAddress(), signTypedData(...),
       toViemAccount(), markApproved(), pending }
signTypedData accepts (domain, types, value) [hip4] AND ({domain, types, primaryType, message}) [viem/nktkas]
owner waits: throw PendingOwnerAction { kind, key, route, approvalId, resumable }
```

The module also exports `SESSION_WALLET_DEFAULT = true`; the scripts never name a wallet,
the signer picks it from the session (a duty with its own wallet, else the owner's wallet),
and `loadSigner` refuses a module without the constant (`SIGNER_OUTDATED`). This dev signer
always answers `walletScope: "main"`.

Contract **extensions** (the production signer must mirror them):
- `agentKey({ create: false })` returns `null` when no key exists instead of creating one
  (production: `GET /butler-read/agent-keys` → `key: null`). `status`, `ensure_spot`,
  `place_bet` and `cancel` always pass it, so read paths never create keys.
- `agentKey()` result has `generated: true` when this call made a new key, first or rotated (production:
  the `generated` field of `POST /butler-exec/agent-keys`). `setup_agent` approves only such a key.

Resume rules:
- Agent-key actions (`place_bet`, `cancel`, `ensure_spot`) are **not resumable**: when the
  signer sets `.pending` or the authorization times out they print `authorization_timeout`.
- Main-wallet steps (`deposit`, `setup_agent`) are resumable: the step is saved to
  `$HOME/.cache/prediction-market/pending/<key>.json`; `--resume <key>` repeats the signer call
  with the same idempotency key (the signer returns the owner's signature / tx) and finishes.
- Every signing script takes `--idempotency-key <key>` (default: generated). Duties pass their
  slot key so a re-fire is refused by the signer instead of betting twice.

Scripts find their own files via `import.meta.url`; never `~/skills/...` (a duty's HOME is its
duty dir; production also injects `BEVO_SKILLS_DIR`).

## Commands

Read-only (safe to run any time):

```bash
node scripts/status.mjs
node scripts/markets.mjs --venue out --query btc
node scripts/markets.mjs --id <marketId>
node scripts/account.mjs
```

Money-moving / signing (the owner runs these; each prints one JSON object):

```bash
node scripts/deposit.mjs --amount 5            # done | deposit_pending (+ resume command; never start a new deposit)
node scripts/setup_agent.mjs                    # done (alreadyApproved) | AGENT_INVALID -> --rotate
DEV_AGENT_NAME=bevo node scripts/setup_agent.mjs --rotate   # fresh key, approved by the main wallet
node scripts/ensure_spot.mjs --amount 2         # done (no-op on unified accounts)
node scripts/ensure_perps.mjs --amount 2        # done (spot -> perps; no-op on unified accounts)
node scripts/withdraw.mjs --amount 2            # L0.5: withdraw_pending | needs_perps | (resume: --resume <key>)
node scripts/place_bet.mjs --market <id> --outcome YES --side buy --size <shares> --price <p>
node scripts/cancel.mjs --order-id <oid>        # or --all
```

### L0.5: withdraw

Needs `DEV_MAIN_PRIVATE_KEY` (the main wallet signs the withdrawal). Withdraws go to
`OUTCOME_MAIN_WALLET` only and are capped at $10 here. Expect `needs_perps` on a standard
account whose money is in spot: run `ensure_perps.mjs --amount <data.amountUsdc>` and then
`withdraw.mjs` again. A successful run prints `withdraw_pending` (about 5 minutes to land
on Arbitrum; `hlConfirmed` tells whether the ledger already lists it). Confirm in a live
test that the minimum is 2 USDC and the fee is 1 USDC (`MIN_WITHDRAW_USDC`,
`HL_WITHDRAW_FEE_USDC` in `scripts/lib/common.mjs`).

Unit tests (no network), from the skill root: `npm test`.
