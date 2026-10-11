"""Experiment 001 — meta-labeling. Implements docs/research/001-meta-labeling-prereg.md.

    python research/experiments/001-meta-labeling/run.py

Committed before its first run. Anything the pre-registration did not specify
is marked IMPLEMENTATION NOTE below and reported with the results.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

HERE = Path(__file__).parent
EMBARGO_MS = 12 * 3600 * 1000
CATEGORICAL = ["pattern", "direction", "timeframe", "regime"]
NUMERIC = ["confidence", "rsi", "volume_ratio",
           "trend_15m_slope", "trend_15m_pos", "trend_1h_slope",
           "trend_1h_pos", "trend_4h_slope", "trend_4h_pos"]
R, LABEL, TWIN = "r_3x15", "label_3x15", "twin_r_3x15"  # primary label only


def cluster_t(values: np.ndarray, clusters: np.ndarray):
    """Mean and cluster-robust t (sum of within-cluster residuals, CR0)."""
    n = len(values)
    if n == 0:
        return float("nan"), float("nan")
    mean = values.mean()
    resid = pd.Series(values - mean).groupby(clusters).sum().to_numpy()
    se = np.sqrt((resid ** 2).sum()) / n
    return float(mean), float(mean / se) if se > 0 else float("nan")


def preprocess():
    # IMPLEMENTATION NOTE: missing numerics (rsi/volume_ratio absent when no
    # rl_experience row) are median-imputed from the training fold only.
    return ColumnTransformer([
        ("num", Pipeline([("imp", SimpleImputer(strategy="median")), ("sc", StandardScaler())]), NUMERIC),
        ("cat", OneHotEncoder(handle_unknown="ignore"), CATEGORICAL),
    ])


def fit_predict(model_name: str, train: pd.DataFrame, test: pd.DataFrame) -> np.ndarray:
    """Boolean 'take' mask for test rows, using only training data for every choice."""
    X_tr, X_te = train[CATEGORICAL + NUMERIC], test[CATEGORICAL + NUMERIC]
    if model_name == "logreg":
        m = Pipeline([("pre", preprocess()), ("clf", LogisticRegression(C=1.0, max_iter=2000))])
        m.fit(X_tr, (train[LABEL] == 1).astype(int))
        p = m.predict_proba(X_te)[:, 1]
        # Break-even win rate implied by the TRAINING set's own average win and loss
        wins, losses = train.loc[train[LABEL] == 1, R], train.loc[train[LABEL] != 1, R]
        w, l = wins.mean(), abs(losses.mean())
        p_star = l / (w + l)
        return p > p_star
    if model_name == "gbt":
        m = Pipeline([("pre", preprocess()), ("reg", HistGradientBoostingRegressor(
            max_depth=3, learning_rate=0.05, max_iter=200, min_samples_leaf=100, random_state=0))])
        m.fit(X_tr, train[R])
        return m.predict(X_te) > 0
    raise ValueError(model_name)


def embargoed(train: pd.DataFrame, test_start: int) -> pd.DataFrame:
    return train[train["detected_at"] < test_start - EMBARGO_MS]


def evaluate(test: pd.DataFrame, take: np.ndarray) -> dict:
    t = test[take]
    mean_r, t_r = cluster_t(t[R].to_numpy(), t["cluster"].to_numpy())
    # Advantage over a coin-flip entry: r - (r + twin)/2 = (r - twin)/2
    adv = ((t[R] - t[TWIN]) / 2).to_numpy()
    mean_adv, t_adv = cluster_t(adv, t["cluster"].to_numpy())
    all_mean, all_t = cluster_t(test[R].to_numpy(), test["cluster"].to_numpy())
    return {
        "n_test": int(len(test)), "n_taken": int(take.sum()),
        "taken_clusters": int(t["cluster"].nunique()),
        "mean_r": mean_r, "t_r": t_r, "mean_adv": mean_adv, "t_adv": t_adv,
        "take_all_mean_r": all_mean, "take_all_t": all_t,
    }


def main():
    df = pd.read_csv(HERE / "data" / "dataset.csv").sort_values("detected_at").reset_index(drop=True)
    n = len(df)
    split = int(np.floor(n * 0.7))
    dev, hold = df.iloc[:split].copy(), df.iloc[split:].copy()
    print(f"rows {n} | development {len(dev)} | hold-out {len(hold)} "
          f"(from {pd.to_datetime(hold.detected_at.min(), unit='ms')} UTC)")

    # Development: 5 equal-count time blocks, expanding-window walk-forward
    blocks = np.array_split(np.arange(len(dev)), 5)
    results = {"development": {}, "holdout": {}, "notes": []}
    for name in ["logreg", "gbt"]:
        per_block, pooled_r, pooled_c = [], [], []
        for k in range(1, 5):
            train = dev.iloc[np.concatenate(blocks[:k])]
            test = dev.iloc[blocks[k]]
            train = embargoed(train, int(test["detected_at"].min()))
            take = fit_predict(name, train, test)
            ev = evaluate(test, take)
            per_block.append(ev)
            pooled_r.append(test[take][R].to_numpy()); pooled_c.append(test[take]["cluster"].to_numpy())
        pr = np.concatenate(pooled_r); pc = np.concatenate(pooled_c)
        pooled_mean, pooled_t = cluster_t(pr, pc)
        results["development"][name] = {"blocks": per_block, "pooled_mean_r": pooled_mean, "pooled_t": pooled_t,
                                        "blocks_positive": sum(1 for b in per_block if b["n_taken"] > 0 and b["mean_r"] > 0)}

    # Model choice: higher pooled mean net R of taken signals across the 4 dev blocks; tie -> logreg
    # IMPLEMENTATION NOTE: "across the 4 blocks" is computed pooled over all taken signals;
    # a model that takes nothing scores -inf.
    def score(name):
        v = results["development"][name]["pooled_mean_r"]
        return -np.inf if np.isnan(v) else v
    chosen = "gbt" if score("gbt") > score("logreg") else "logreg"
    results["chosen_model"] = chosen

    # Hold-out: looked at once. Both models reported; only the chosen one decides.
    for name in ["logreg", "gbt"]:
        train = embargoed(dev, int(hold["detected_at"].min()))
        take = fit_predict(name, train, hold)
        results["holdout"][name] = evaluate(hold, take)

    h = results["holdout"][chosen]
    d = results["development"][chosen]
    criteria = {
        "1_at_least_300_taken": h["n_taken"] >= 300,
        "2_mean_r_positive_t3": h["mean_r"] > 0 and h["t_r"] >= 3,
        "3_beats_random_t3": h["mean_adv"] > 0 and h["t_adv"] >= 3,
        "4_dev_positive_3_of_4": d["blocks_positive"] >= 3,
    }
    results["criteria"] = criteria
    results["verdict"] = "PASS" if all(criteria.values()) else "FAIL"

    out = HERE / "data" / "results.json"
    out.write_text(json.dumps(results, indent=2, default=float))
    print(json.dumps({k: results[k] for k in ["chosen_model", "criteria", "verdict"]}, indent=2))
    print(f"full results: {out}")


if __name__ == "__main__":
    sys.exit(main())
