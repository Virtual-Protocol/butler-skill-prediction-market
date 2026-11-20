# butler-skill-prediction-market

Butler skill for Outcome.xyz prediction markets (Hyperliquid HIP-4). This repository is the
**only** place Butler learns Outcome.xyz and Hyperliquid: bevo-server and the container hold
no venue knowledge. They provide a generic signer (`BEVO_SIGNER`, backed by `bevo-wallet`)
for the owner's or a duty's main wallet and for a server-held agent key.

## Layout

| Path | What |
| --- | --- |
| `SKILL.md` | The playbook the model follows (hub standard: seven sections, 12,000-char body) |
| `references/commands.md` | Every script's flags, statuses, output fields and error codes |
| `references/outcome-sdk.md` | HIP-4 / Outcome.xyz concepts and which SDK call each script makes |
| `references/hyperliquid-sdk.md` | Deposit, withdraw, perps vs spot, agent keys, nonces |
| `scripts/*.mjs`, `scripts/lib/common.mjs` | The only code that touches the venues; one JSON envelope per run |
| `package.json`, `package-lock.json` | Pinned `@outcome.xyz/hip4` 1.3.0, `@nktkas/hyperliquid` 0.33.3, `viem`; at the skill root, never under `scripts/` |
| `dev/` | Local signer for mainnet tests from a Mac (`dev/README.md`); not published |

Flow: `status` → `deposit` → `setup_agent [--rotate]` → `ensure_spot` → `place_bet` /
`cancel`; exit: `withdraw` (to the same wallet; `ensure_perps` first when the money sits
in spot); reads `markets`, `account`. Unit tests (no network): `npm test`.

## Publishing notes

- The hub publishes `SKILL.md` and `references/**/*.md`; publishing `scripts/**/*.mjs` and
  the root package files needs the hub and container rule change described in the
  workspace plan (`docs/plans/skill-driven-dapp-refactor.md` §2.5).
- Validate with `python3 <butler-skills>/scripts/validate.py --standalone <a copy without node_modules>`.
- Bump `version` and add a `CHANGELOG.md` entry for every change, and bump the `ref` in
  `butler-skills/skills.json` in the same change-set.

## Related skills

| Package | What it covers |
| --- | --- |
| `butler-skill-polymarket-web` | Polymarket via browser automation |
| `butler-skill-variational` | Variational Omni perps |
