# Cost-aware replay

Replays logged signals against Bybit 1-minute candles with the engine's exit
logic **and real costs** (Bybit taker 0.055% / maker 0.02%, stop slippage, stops
that gap fill at the bar open). Any claim that a rule or setup "works" must come
from here — see `docs/PLAN_HISTORY.md` for the rules it has to meet.

## Data (gitignored, under `data/`)

```bash
DBURL=<railway postgres url> node research/replay/dump-signals.cjs   # data/db.json
node research/replay/fetch-candles.cjs                                # data/k1m/*.json
curl -s https://tradeflow-henna.vercel.app/api/live/state > research/replay/data/state.json
```

`data/htf.json` (signal id → 1h regime label) is optional; without it the
with/against-trend split reports everything as neutral.

## Scripts

| Script | What it answers |
|---|---|
| `validate.cjs` | Does the simulator reproduce the real paper trades? Run this first. (2026-10-04: 153/153) |
| `analyze.cjs` | Expectancy gross vs net, by stop rule, pattern, period, timeframe, trend |
| `nulltest.cjs` | How many "positive in every period" rule combos appear by pure chance? |
| `baseline.cjs` | Do pattern entries beat random-direction entries with identical exits? t-stats |
| `label-signals.ts` | Writes triple-barrier labels for every signal and backfills trend features into the Railway DB (`signal_labels`, `signal_features`). Run with `npx tsx research/replay/label-signals.ts`; re-run daily to label new signals. |

A setup is eligible for `ALLOWED_SETUPS` only if `baseline.cjs`-style testing
shows it beats random-direction twins net of costs at t ≥ 3 over ≥ 300 trades.
