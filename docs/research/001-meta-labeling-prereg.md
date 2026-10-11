# Experiment 001 — Can a meta-labeling model find a profitable subset of signals?

**Pre-registered 2026-10-11, before any model was fitted or any result seen.**
The git commit containing this file is the timestamp. Changes after the first
run must be recorded as amendments below, never edited in place.

## Question

Given only information available at signal time, can a model pick a subset of
the engine's signals whose outcomes are **positive net of costs** and **better
than random-direction entries with identical exits**, out of sample?

## Data (fixed)

- **Signals:** `signal_log` rows detected **before 2026-10-11 11:53 UTC** (the
  Bybit-seeded EU deploy). Nothing after that date is used.
- **Label (primary):** `signal_labels.config = 'tb_3x1.5_48'` — `ret_r_net`
  (net R) and `label`. Chosen in advance because it carries less fee drag than
  `tb_2x1_48`. The 2×1 config is reported for reference only and never used for
  the decision.
- **Features:** only from `signal_features` with `source = 'backfill'` (pure
  Bybit; `live_mixed` rows excluded), plus fields logged at signal time:
  - categorical: pattern, direction, timeframe, regime (5m/15m regime from `signal_log`)
  - numeric: confidence, rsi, volume_ratio (from `rl_experience`),
    trend_{15m,1h,4h}_{slope,pos}
  - **Excluded:** symbol (10 levels would be memorised), hour and weekday
    (PLAN_HISTORY rule 6), edge_score and tier (derived from the same inputs).
- **Random-direction twin** (the baseline): for every signal, the same barrier
  outcome computed with the opposite direction from the same candles and costs.
  A coin-flip entry's expected R is the mean of the signal's and its twin's.

## Clustering and leakage control (fixed)

- **Cluster:** consecutive detections of the same symbol + timeframe + pattern +
  direction less than 30 minutes apart form one cluster (one underlying setup).
  All uncertainty is computed over clusters, never rows.
- **Embargo:** 12 hours (the longest label horizon, 48 × 15m) between any
  training data and the following test period.

## Splits (fixed)

- **Hold-out:** the most recent 30% of signals by time. Looked at **once**, by
  the final model, after the model choice is made.
- **Development:** the earlier 70%, split by time into 5 equal blocks;
  expanding-window walk-forward — train on blocks 1..k, test on block k+1
  (k = 1..4), with the embargo.

## Models (exactly two, fixed settings, no tuning)

1. **Logistic regression** for P(label = +1), standardised numerics, one-hot
   categoricals, L2 with C = 1.0.
2. **Gradient-boosted trees** (`HistGradientBoostingRegressor`) for `ret_r_net`:
   max_depth 3, learning_rate 0.05, max_iter 200, min_samples_leaf 100,
   random_state 0.

**Take rule:** take a signal when the model's predicted value beats the
break-even computed **on the training data only** — for (1) P(+1) above the
training-set break-even win rate implied by its own average win and loss sizes;
for (2) predicted net R > 0.

**Model choice:** the model with the higher mean net R of taken signals across
the 4 development test blocks. Ties → logistic regression (simpler).

## Success bar (all must hold on the hold-out)

1. At least **300 taken signals**.
2. Mean net R of taken signals **> 0**, cluster-robust **t ≥ 3**.
3. Mean paired advantage over the random-direction twin (signal R − coin-flip R)
   **> 0**, cluster-robust **t ≥ 3**.
4. In development, taken-signal mean net R **positive in at least 3 of 4** test blocks.

If any condition fails, the answer is **no**: no setup or model enters
`ALLOWED_SETUPS`, and the next step is better inputs (volatility, structure,
derivatives features; 1h/4h signals) — not more model search.

## What gets reported regardless of outcome

All four development blocks and the hold-out for both models: n taken, mean net
R, t-stats, advantage over random, and the take-all baseline. Number of model
variants tried: **2**.

## Amendments

(none)
