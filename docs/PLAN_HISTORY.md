# TradeFlow — plan history, decisions and lessons

This is the institutional memory the `ship-reviewer` agent reviews every push
against. Newest first. When a ship changes strategy, risk or exits, add an entry
here in the same commit.

---

## 2026-10-06 (2) — Label every signal; multi-timeframe trend features

**Decisions (Nitin):** build both offline labels and new features; label with
**ATR triple-barrier** outcomes; store in **new Railway tables**; features =
**multi-timeframe trend** only (volatility/structure/derivatives not chosen).

- `signal_labels` — every logged signal (taken, shadowed or rejected), labelled
  offline by `research/replay/label-signals.ts` from Bybit 1m candles, net of
  the engine's cost model. Configs stored per row: `tb_2x1_48` (profit 2×ATR,
  stop 1×ATR, 48 bars of the signal's timeframe) and `tb_3x1.5_48`. ATR(14) of
  the signal's timeframe from bars closed before the signal. Stop checked before
  profit inside each 1m bar; gapped stops fill at the open. Re-runnable.
- `signal_features` — EMA20 slope and close-vs-EMA50 (both in ATRs) on 15m,
  1h and 4h (4h built from complete 1h groups), over the last 120 bars.
  Written live by the engine and backfilled by the labeller; both call
  `lib/features.ts` on the same 500 closed bars, and Bybit's native 15m/1h
  candles matched our 1m aggregation exactly (199/199 bars each), so live and
  backfilled values agree. `FEATURE_VERSION` = 1.
- Fix: the REST seed stored the still-forming candle as closed, leaving a
  duplicate partial bar in every buffer after a restart (affected patterns,
  ATR and these features). The seed now skips it and the buffer replaces a bar
  that arrives twice.

**Training caveats:** labels are policy-independent barrier outcomes, not the
engine's exit policy. Barrier parameters are a first choice, not tuned — tuning
them is a rule search and falls under the validation rules (combos counted,
shuffle baseline, hold-out).

---

## 2026-10-06 — RL data: label shadow outcomes

**Goal (Nitin):** collect good data for reinforcement learning and, from it, a
profitable algorithm. **Modelling plan:** supervised meta-labeling first
(predict net R per signal, validated walk-forward against the random-entry
baseline); RL only if that shows real signal.

**Problem:** `rl_experience` had 16,908 rows but only 92 outcomes (0.5%). Only
*paper* trades wrote outcomes back, so every log-only shadow trade produced an
unlabelled row, and the labelled set held only trades the engine chose to take
— a selection-biased sample.

**Change:** shadow trades now write their outcome to the signal's
`rl_experience` row (joined on `signal_id`). New column `outcome_source`
(`paper` | `shadow`) keeps the two apart. `initDb` backfills shadow trades that
closed before this change (15 on 2026-10-06), idempotently. `reward` remains
percent P&L net of costs; R-multiples are on `shadow_trades.r_multiple`.

**Still unlabelled by design:** signals rejected by the stop floor or net R:R
(~95% of signals). Labelling those needs offline counterfactual outcomes from
candles — a candidate next step, not yet decided.

---

## 2026-10-04 (follow-up) — Deploy variables can only tighten the engine

Raised by the ship-reviewer on the log-only push: Railway variables could set
fees to 0, lower the stop floor, raise risk (the July setup put
`RISK_PER_TRADE` in Railway's variables) or enable setups, all without review.

**Decision (Nitin):** guard the overrides. Env vars may make the engine more
conservative, never less:

- `TAKER_FEE`, `MAKER_FEE`, `STOP_SLIPPAGE`, `MIN_STOP_PCT` — values below the
  reviewed defaults are ignored (with a warning); higher values are honoured.
- `RISK_PER_TRADE` — capped at 0.25%; lower values are honoured.
- `ALLOWED_SETUPS` — can only narrow `VALIDATED_SETUPS` in
  `lib/server/signal-processor.ts` (empty). Adding a setup is a code change.
- The effective config is logged once at startup (`[config] …`).

---

## 2026-10-04 — Re-examination: no edge net of costs → log-only

**What was found** (153 paper trades, 8 Sep–4 Oct; 11,540 logged signals →
5,105 unique setups; replayed on Bybit 1m candles; replay matched 153/153 live
outcomes):

- Account: $500,000 → $351,685 (−29.7%) as recorded. The engine charged **no
  fees**. Net of Bybit costs the same trades are −79R, roughly −$390,000.
- Gross expectancy of all setups: **−0.05R/trade**. Random-direction entries
  with identical exits did no worse (+0.01R). The patterns carry no usable
  directional information on 5m/15m.
- The "tightest of pattern stop / 1.5×ATR / 1%" rule (2 Oct) put the median stop
  at 1.5 ATR on 5m bars: 40% of stop-outs within 15 minutes, costs **0.60R per
  trade**. 3×ATR stops cut costs to 0.14R — still net negative.
- The 2 Oct rule set ("only H&S short + Bearish Engulfing short, positive in all
  4 replay periods") was picked from ~1,000 combinations **without costs**.
  Shuffled-outcome null: 17% of pure-chance runs produce as many "all-4-positive"
  combos. Net of costs, zero combos pass. Under the live stop rule both setups
  were reliably negative (t = −2.9, −4.9); live after 2 Oct: 3 wins / 16.
- Each rule change after the 8–11 Sep baseline (−$4.2k / 52 trades) did worse:
  −$70k, −$50k, −$24k. Six strategy changes in seven days, each on 24–61 trades.
- Bugs: daily loss limit never fired 8 Sep–2 Oct (`incState` type error, fixed
  2 Oct); stops filled at the stop price even when price had gapped past it;
  `MIN_RR` checked before the stop was tightened; breakevens counted as losses;
  `bars_held` assumed 15m bars for 5m trades; a halt stopped exit management of
  open positions.

**Decisions (Nitin, 2026-10-04):**

| Decision | Choice |
|---|---|
| Engine mode | **Log-only** — no paper trades; every setup that passes the stop/R:R rules is followed as a shadow trade (`shadow_trades`) with full costs |
| Pattern stop tighter than floor | **Skip the signal** (never widen) |
| Risk limits | **0.25% of equity per trade, max 2 open, 3% daily loss limit, auto-halt at −10% from equity peak (manual restart)** |
| Fee model | **Bybit base tier**: 0.055% taker (entries, stops, timeouts), 0.02% maker (take-profits), 0.01% stop slippage |
| Stop floor | 1.1% of price (keeps round-trip taker cost ≤ 0.1R) |
| Setups allowed to paper-trade | **None** until validated (rules below) |

**Rules a strategy change must satisfy before it ships:**

1. Every P&L number — replay, shadow, paper, dashboard — is net of costs.
2. A setup may be added to `ALLOWED_SETUPS` only when its shadow trades (or a
   cost-aware replay with `research/replay`) beat **random-direction twins with
   identical exits**, net of costs, at **t ≥ 3**, over **≥ 300 trades**.
3. Any rule search reports **how many combinations were tried** and the
   **shuffled-outcome baseline**; a result counts only if it beats the 95th
   percentile of the shuffles.
4. The most recent ~30% of data is a hold-out, looked at once, after the rule is
   chosen.
5. **One strategy change per ship. Rules are frozen for 200 trades or 4 weeks**
   after a strategy change (bug fixes and risk *reductions* are exempt).
6. Day-of-week / hour-of-day splits are not grounds for a filter at current
   sample sizes.

**Open research question:** June validated the strategy on **1h** (below), but
live traded 5m/15m. Next experiment is logging the detectors on 1h (and 4h) in
log-only mode and testing them against rule 2. The June simulator modelled
slippage but **not exchange fees**, so the June 1h numbers must be re-checked
net of costs before they are trusted.

---

## 2026-10-02 — Tight stops + "positive in all 4 periods" setups (REVERSED 10-04)

- `cd1c697` fixed `incState` (daily loss limit had never triggered).
- `37bc9bc` initial stop = tighter of pattern / 1.5×ATR / 1%; risk 1% of current
  equity. **Lesson:** tighter stops raised costs in R and stop-out frequency.
- `30cfbf4` only H&S short + Bearish Engulfing short, max 4 open, edge score and
  1h trend filter removed. **Lesson:** selected from ~1,000 gross-only combos;
  indistinguishable from chance.

## 2026-09-27 — Replay-backed rules (`dd31fcb`, `5a43108`)

- First replay of all logged signals (validated 72/72). Restored 1h trend
  alignment, excluded Ascending Triangle / Double Bottom / Morning Star, MIN_EDGE
  60, max 5 open, TP2 = pattern target, WebSocket ping + 90s watchdog (engine
  logged zero signals 11–26 Sep: silently dead socket).
- Kept: per-symbol serialization of 5m+15m evaluation, atomic state increments,
  open risk counted against the daily limit.
- **Lesson:** replays were gross of costs.

## 2026-09-26 — 52-trade analysis (`864b7c5`, `a7c2a53`)

- Removed ADAUSDT (~$0.20 price → sub-cent stops hit by noise), excluded
  Shooting Star and Hammer, MIN_EDGE 70→65, counter-trend block, 0.3% min stop,
  TP2 ≥ 2R. Most of this was reverted the next day.
- Fixed capital being reset to `STARTING_CAPITAL` on every dashboard poll.
- **Lesson:** five filters on 52 trades is fitting noise.

## 2026-09-08 — Engine restart at $500k (`e93bafd`)

- 10 symbols, 5m + 15m signals, 1h as regime filter, trailing stop after TP1,
  MIN_EDGE 70, partial-exit P&L.
- **Drift from the validated plan:** June validated 1h signals with fixed exits;
  live switched to 5m/15m with TP1/trail exits without re-validation.

## 2026-09-06 — Railway/Vercel deployment saga

- Engine runs on **Railway** (`ENABLE_ENGINE=true`); **Vercel** serves the
  dashboard only. Both deploy from `master` on push.
- Many temporary debug commits exposed DB host/port/error details in API
  responses. **Rule:** no debug endpoints or DB error details in shipped code.

## 2026-07-01 — Server-side paper engine + RL pipeline (`864d980`, `32f4510`)

- Market data: Bybit (Binance blocks Railway US with HTTP 451); Binance US is the
  REST fallback.
- `rl_experience` logs every signal (acted and skipped); outcomes on close.
  `reward` is percent P&L (net of costs from 2026-10-04).

## 2026-06 — Research phase (training-exports/)

- **Master plan:** `MASTER_PROMPT_V3.md` — client app rebuild and its 24 critical
  rules (support < price < resistance, closed candles only, R:R ≥ 1.5, one trade
  per symbol, breakeven on TP1, etc.).
- Phase 3 (score floor, exit logic, trail distance, regime sizing) on 6 fixed
  windows; **Phase 3E** confirmed excluding ranging regimes.
- **Go/No-Go (2026-06-22):** fresh windows F1–F3 confirmed generalization,
  BTC/ETH/SOL 15m+1h, "Config A" (score floor 60, fixed exit, uniform sizing).
- **Independent 2022 validation:** 6/7 sub-runs profitable; **1h strong** (BTC
  PF 2.01, ETH PF 2.19), **15m weak** (ETH 15m PF 0.99). No exchange fees modelled.
