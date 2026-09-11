"""
Independent cross-check of the TypeScript fitter and metrics.

The engine's statistics are hand-written in TypeScript so that the same code
runs in a browser tab and in a route handler with no dependencies. That is a
good property for deployment and a bad one for trust: a hand-written ROC AUC
or isotonic regression can be subtly wrong in ways that flatter the result.

This script reproduces every stage from the exported feature rows using
NumPy, SciPy and scikit-learn, and compares:

  1. the per-bin log-likelihood ratios against model.json;
  2. the penalised maximum-likelihood weights against the IRLS weights;
  3. the fused log-odds computed here against the engine's own scores;
  4. ROC AUC, average precision, KS and Brier against model.json and the
     evaluation output;
  5. an independent isotonic calibration against the committed knot map.

It reads nothing the runtime needs and writes nothing the runtime reads.

Usage:
    npm run seed -- --export        # writes data/export/features.csv
    python analysis/crosscheck.py   # from the repository root
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Windows consoles default to a legacy code page that cannot print a rupee sign.
sys.stdout.reconfigure(encoding="utf-8")

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score, roc_curve

ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = ROOT / "data" / "model.json"
FEATURES_PATH = ROOT / "data" / "export" / "features.csv"

# Mirrors packages/sim/src/fit.ts. If those change, change these.
SMOOTHING = 0.5
RIDGE = 12.0
# Mirrors packages/core/src/signals/specs.ts SIGNAL_ORDER and group membership.
GROUP_OF = {
    "PAYEE_NOVELTY": "payee_graph",
    "AMOUNT_DEVIATION": "behavioural",
    "TEMPORAL_ANOMALY": "behavioural",
    "DEVICE_DRIFT": "identity_device",
    "PAYEE_FAN_IN": "payee_graph",
    "PAYEE_ACCOUNT_AGE": "payee_graph",
    "CALL_CONCURRENCY": "context",
    "SESSION_URGENCY": "context",
    "STRUCTURING": "structuring",
    "VELOCITY_BURST": "behavioural",
    "DRAIN_RATIO": "behavioural",
    "MULE_PROXIMITY": "payee_graph",
}


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, bool]] = []

    def check(self, name: str, ok: bool, detail: str) -> None:
        self.rows.append((name, detail, ok))
        print(f"  {'ok  ' if ok else 'FAIL'}  {name:<46} {detail}")

    @property
    def failed(self) -> list[str]:
        return [n for n, _, ok in self.rows if not ok]


def logit(p: float) -> float:
    return float(np.log(p / (1 - p)))


def shrinkage(rho: float, count: int) -> float:
    if count <= 1:
        return 1.0
    return 1.0 / (1.0 + (count - 1) * min(max(rho, 0.0), 0.95))


def design_matrix(bins: np.ndarray, model: dict, order: list[str]) -> np.ndarray:
    """LLR per signal, discounted by group co-firing, exactly as the engine does."""
    tables = {s["id"]: np.asarray(s["llrByBin"], dtype=float) for s in model["signals"]}
    llr = np.column_stack([tables[sid][bins[:, i]] for i, sid in enumerate(order)])
    groups = [GROUP_OF[sid] for sid in order]
    rho = model["groupShrinkage"]
    active = np.abs(llr) > 1e-6
    out = np.empty_like(llr)
    for g in set(groups):
        idx = [i for i, gg in enumerate(groups) if gg == g]
        count = active[:, idx].sum(axis=1)
        factor = np.array([shrinkage(rho.get(g, 0.0), int(c)) for c in count])
        out[:, idx] = llr[:, idx] * factor[:, None]
    return out


def apply_asymmetric_floor(contrib: np.ndarray, model: dict, order: list[str]) -> np.ndarray:
    """The cap on negative evidence from attacker-controllable groups, mirrored from fit.ts."""
    cfg = model.get("asymmetricEvidence")
    if not cfg or not cfg["cappedGroups"]:
        return contrib
    out = contrib.copy()
    groups = [GROUP_OF[sid] for sid in order]
    for g in cfg["cappedGroups"]:
        idx = [i for i, gg in enumerate(groups) if gg == g]
        if not idx:
            continue
        block = out[:, idx]
        total = block.sum(axis=1)
        negative = np.minimum(block, 0).sum(axis=1)
        needs = (total < cfg["negativeFloor"]) & (negative != 0)
        scale = np.ones_like(total)
        scale[needs] = (cfg["negativeFloor"] - (total[needs] - negative[needs])) / negative[needs]
        neg_mask = block < 0
        block = np.where(neg_mask, block * scale[:, None], block)
        out[:, idx] = block
    return out


def fit_weights(design: np.ndarray, y: np.ndarray, offset: float) -> np.ndarray:
    """Penalised logistic MLE with the ridge centred on one, as in fitWeights()."""

    def objective(w: np.ndarray) -> float:
        z = offset + design @ w
        # log(1 + e^z) - y z, computed stably
        ll = np.sum(np.logaddexp(0.0, z) - y * z)
        return ll + 0.5 * RIDGE * np.sum((w - 1.0) ** 2)

    def gradient(w: np.ndarray) -> np.ndarray:
        z = offset + design @ w
        p = 1.0 / (1.0 + np.exp(-z))
        return design.T @ (p - y) + RIDGE * (w - 1.0)

    res = minimize(objective, np.ones(design.shape[1]), jac=gradient, method="L-BFGS-B")
    return res.x


def ks_statistic(scores: np.ndarray, y: np.ndarray) -> float:
    fpr, tpr, _ = roc_curve(y, scores)
    return float(np.max(tpr - fpr))


def interp_calibration(knots: list[dict], x: np.ndarray) -> np.ndarray:
    xs = np.array([k["x"] for k in knots])
    ys = np.array([k["y"] for k in knots])
    return np.interp(x, xs, ys)


def ece(pred: np.ndarray, y: np.ndarray, bins: int = 12) -> float:
    order = np.argsort(pred)
    p = pred[order]
    t = y[order]
    total = 0.0
    for chunk_p, chunk_t in zip(np.array_split(p, bins), np.array_split(t, bins)):
        if len(chunk_p) == 0:
            continue
        total += len(chunk_p) * abs(chunk_p.mean() - chunk_t.mean())
    return float(total / len(pred))


def main() -> int:
    if not FEATURES_PATH.exists():
        print(f"Missing {FEATURES_PATH}. Run `npm run seed -- --export` first.")
        return 2

    model = json.loads(MODEL_PATH.read_text(encoding="utf8"))
    order = [s["id"] for s in model["signals"]]
    df = pd.read_csv(FEATURES_PATH)
    train = df[df.split == "train"]
    test = df[df.split == "test"]
    bin_cols = [f"bin_{sid}" for sid in order]

    print(f"Model {model['version']}")
    print(f"  train {len(train):,} rows ({int(train.isFraud.sum())} fraud), test {len(test):,} rows ({int(test.isFraud.sum())} fraud)\n")
    report = Report()

    # 1. Weight of evidence per bin, on bins with enough observations to be
    #    fitted directly rather than filled.
    worst_llr = 0.0
    for i, sid in enumerate(order):
        spec = model["signals"][i]
        n_bins = len(spec["llrByBin"])
        counts_f = np.bincount(train[bin_cols[i]][train.isFraud == 1], minlength=n_bins).astype(float)
        counts_l = np.bincount(train[bin_cols[i]][train.isFraud == 0], minlength=n_bins).astype(float)
        p_f = (counts_f + SMOOTHING) / (counts_f.sum() + SMOOTHING * n_bins)
        p_l = (counts_l + SMOOTHING) / (counts_l.sum() + SMOOTHING * n_bins)
        llr = np.log(p_f / p_l)
        observed = (counts_f + counts_l) >= 5
        diff = np.abs(llr[observed] - np.asarray(spec["llrByBin"])[observed]).max() if observed.any() else 0.0
        worst_llr = max(worst_llr, float(diff))
    report.check("weight-of-evidence tables reproduce", worst_llr < 1e-6, f"max |Δllr| {worst_llr:.2e} on observed bins")

    # 2. Weights.
    base_rate = model["baseRate"]
    offset = logit(base_rate)
    X_train = design_matrix(train[bin_cols].to_numpy(), model, order)
    y_train = train.isFraud.to_numpy().astype(float)
    w_py = fit_weights(X_train, y_train, offset)
    w_ts = np.array([s["weight"] for s in model["signals"]])
    max_dw = float(np.abs(w_py - w_ts).max())
    report.check("penalised MLE weights match IRLS", max_dw < 2e-3, f"max |Δw| {max_dw:.2e}")
    for sid, a, b in zip(order, w_ts, w_py):
        print(f"        {sid:<20} ts {a:7.4f}   py {b:7.4f}")

    # 3. Scores. The engine's own raw log-odds are in the export; recompute here
    #    with the committed weights and the asymmetric floor.
    X_test = design_matrix(test[bin_cols].to_numpy(), model, order)
    contrib = apply_asymmetric_floor(X_test * w_ts, model, order)
    raw_py = offset + contrib.sum(axis=1)
    raw_ts = test.rawLogOdds.to_numpy()
    max_dz = float(np.abs(raw_py - raw_ts).max())
    report.check("fused log-odds reproduce", max_dz < 1e-6, f"max |Δ log-odds| {max_dz:.2e} over {len(test):,} rows")

    # 4. Discrimination and calibration on the held-out window.
    y_test = test.isFraud.to_numpy().astype(int)
    cal_ts = interp_calibration(model["calibration"], raw_ts)
    p_ts = test.calibratedP.to_numpy()
    max_dp = float(np.abs(cal_ts - p_ts).max())
    report.check("calibration map interpolates identically", max_dp < 1e-6, f"max |Δp| {max_dp:.2e}")

    auc = roc_auc_score(y_test, p_ts)
    ap = average_precision_score(y_test, p_ts)
    ks = ks_statistic(p_ts, y_test)
    brier = brier_score_loss(y_test, p_ts)
    m = model["metrics"]
    report.check("ROC AUC matches sklearn", abs(auc - m["rocAuc"]) < 1e-6, f"ts {m['rocAuc']:.6f}  sklearn {auc:.6f}")
    report.check("KS matches sklearn ROC", abs(ks - m["ks"]) < 1e-6, f"ts {m['ks']:.6f}  sklearn {ks:.6f}")
    report.check("Brier matches sklearn", abs(brier - m["brier"]) < 1e-9, f"ts {m['brier']:.8f}  sklearn {brier:.8f}")
    # Average precision and a trapezoidal PR AUC are different estimators of
    # the same area; they should agree closely, not exactly.
    report.check("PR AUC close to average precision", abs(ap - m["prAuc"]) < 0.01, f"ts {m['prAuc']:.4f}  sklearn AP {ap:.4f}")

    # 5. Independent isotonic calibration, fitted on the training window.
    X_tr_contrib = apply_asymmetric_floor(X_train * w_ts, model, order)
    raw_train = offset + X_tr_contrib.sum(axis=1)
    iso = IsotonicRegression(out_of_bounds="clip").fit(raw_train, y_train)
    p_iso = iso.predict(raw_ts)
    ece_ts = ece(p_ts, y_test)
    ece_iso = ece(p_iso, y_test)
    brier_iso = brier_score_loss(y_test, p_iso)
    report.check(
        "committed calibration within reach of sklearn isotonic",
        abs(ece_ts - ece_iso) < 0.01 and abs(brier - brier_iso) < 5e-4,
        f"ECE ts {ece_ts:.4f} / sklearn {ece_iso:.4f}; Brier ts {brier:.6f} / sklearn {brier_iso:.6f}",
    )

    # The single-signal guard, independently.
    strongest = 0.0
    strongest_id = ""
    for i, sid in enumerate(order):
        llr_i = np.asarray(model["signals"][i]["llrByBin"])[test[bin_cols[i]].to_numpy()]
        a = roc_auc_score(y_test, llr_i)
        if a > strongest:
            strongest, strongest_id = a, sid
    report.check("no single signal separates alone", strongest <= 0.98, f"strongest {strongest_id} {strongest:.4f}")

    failed = report.failed
    print(f"\n{len(report.rows) - len(failed)} of {len(report.rows)} checks passed.")
    if failed:
        print("Failed: " + "; ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
