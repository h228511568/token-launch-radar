[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/h228511568/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/h228511568/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Launch Radar

A radar for token launches that have not happened yet. It reads the sealed DefiLlama
snapshot shipped with the make.fun `token-radar-01` bounty (758 protocols, snapshot
dated 2026-11-14), decides which of them genuinely have no token, scores each one with
a calibrated implied valuation, and renders the result as a static dashboard with a
concrete farm plan per protocol.

## What it produces

- `board.json` — 198 ranked pre-token protocols, all 40 watchlist protocols covered.
- `dashboard/` — a zero-network static page (board, live-token view, per-protocol
  detail drawer) driven by the generated `data.js`.
- `screenshots/` — the board, one protocol's detail drawer, and the watchlist-only
  filtered view, captured from the real dashboard.
- `dossier.json` — the make.fun dossier, built last from everything above.

## The model (radar-2)

Pre-token is strict: a protocol qualifies only when the snapshot has **no token on
record at all** — no market cap, no symbol, no CoinGecko id. That one rule removes
famous names whose tokens exist but are simply not priced in the index.

    implied = TVL x base multiple x growth x maturity x chains

- **Base multiple** — calibrated from the snapshot itself: the median market-cap / TVL
  ratio of its live-token protocols (0.3211x across 102 protocols; ratios outside
  0.02–20 and exchange tokens excluded). Ten categories have at least four live
  samples and price their own rows with their category median instead.
- **Growth** — the 7-day TVL change, clamped to −60%…+120%, at half weight.
- **Maturity** — rewards protocols that have run longer without a token
  (0.6 + age/3y × 0.4, capped at three years; unknown listing date counts as one year).
- **Chains** — +3% per additional chain, up to four.

Wrapped, staked, bridged and exchange-issued forms of an existing asset are never
ranked — their launch already happened. Each row also carries a seven-step farm plan
(fresh wallet, main action, a category-specific second action, weekly upkeep, points
program check, hold-and-review) with a capital tier ($50 / $100 / $150 by TVL), a hold
window that shortens as a protocol ages, and a farm-efficiency score of implied value
per dollar per day.

## Run it

    node main.ts --input <path-to-snapshot.json>   # output: $MAKEFUN_OUTPUT_DIR or /output

Node 22, standard library only. The run is deterministic: the same snapshot produces
byte-identical output. `lib/model.ts` holds the whole model; `main.ts` is the thin
entry point that writes the deliverables and builds the dossier with the vendored
`vendor/makefun-board.ts`.
