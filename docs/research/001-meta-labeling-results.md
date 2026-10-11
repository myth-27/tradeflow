# Experiment 001 — results: FAIL

Run once on 2026-10-11, exactly as pre-registered in
`001-meta-labeling-prereg.md` (prereg `a147584`, amendment A1 `a039ff9`, runner
`a4d10ec`, all committed before the run).

## Data

25,123 signals (8 Sep – 11 Oct, before the cutoff) in **7,482 clusters**; primary
label `tb_3x1.5_48`, net of costs. Labels and backfilled features were rebuilt
after the 1m-candle repair (2,950 label values shifted slightly, 6 changed
outcome class). A1 check: 17,015 of 17,015 backfill rows reproduced exactly.
Development 17,586 rows / hold-out 7,537 rows (from 2026-10-06 23:10 UTC).

## Development (walk-forward, 12h embargo)

| Model | Pooled taken mean | t | Blocks positive |
|---|---|---|---|
| Logistic regression | −0.392R | −7.86 | 0 / 4 |
| Gradient-boosted trees | −0.433R | −7.66 | 0 / 4 |

Per block, the taken set rarely beat simply taking every signal, and its
advantage over random-direction entries ranged from −0.86R to +0.05R.

## Hold-out (looked at once)

| Model | Taken | Mean net R | t | Advantage vs random | t | Take-all |
|---|---|---|---|---|---|---|
| **Logistic regression (chosen)** | 0 | — | — | — | — | −0.415R |
| Gradient-boosted trees | 366 (99 clusters) | −0.266R | −1.47 | +0.096R | 0.53 | −0.415R |

## Criteria

| | Result |
|---|---|
| ≥ 300 taken | ✗ (0) |
| Mean net R > 0, t ≥ 3 | ✗ |
| Beats random-direction twin, t ≥ 3 | ✗ |
| Positive in ≥ 3 of 4 dev blocks | ✗ (0 / 4) |

**Verdict: FAIL.** With the engine's current signals and features, no model
finds a subset that is profitable net of costs or better than random entries.
The chosen model's answer — take nothing — is the correct reading of the data.

## Implementation notes (not specified by the prereg)

- Missing numerics median-imputed from the training fold only.
- Model choice used the pooled mean over all taken development signals.
- `volume_ratio` has a long tail (median 0.76, p99 18.8, max ~195); left as logged.

## Consequence (per the prereg)

Nothing enters `ALLOWED_SETUPS`. No further model search on these inputs. Next
step is better inputs: volatility context, support/resistance structure,
derivatives (funding, open interest), and logging 1h/4h signals — then a new,
separately pre-registered experiment.
