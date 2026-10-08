"""Trains the light model used by the browser version (docs/demo).

Logistic regression (risk) and ridge regression (health) on the same features
as the server model, exported as plain weights to frontend/model_lite.json.

Usage (from the backend/ folder):  python ../scripts/train_lite.py
"""
import json
import sys
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import mean_absolute_error, roc_auc_score
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app.ml import FEATURES, generate_dataset  # noqa: E402


def poly(Z):
    return np.hstack([Z, Z ** 2])


def main():
    X, yf, yh, g = generate_dataset(seeds=(11, 12, 13, 14), days=6)
    te = g == 14
    tr = ~te
    sc = StandardScaler().fit(X[tr])
    Z = poly(sc.transform(X))
    clf = LogisticRegression(C=1.0, max_iter=2000).fit(Z[tr], yf[tr])
    reg = Ridge(alpha=1.0).fit(Z[tr], yh[tr])
    p = clf.predict_proba(Z[te])[:, 1]
    top = p >= np.quantile(p, 0.9)
    m = {
        "roc_auc": round(roc_auc_score(yf[te], p), 3),
        "lift_top10": round(float(yf[te][top].mean() / yf[te].mean()), 2),
        "recall_top10": round(float(yf[te][top].sum() / yf[te].sum()), 3),
        "samples": int(len(X)),
        "health_mae": round(float(mean_absolute_error(yh[te], np.clip(reg.predict(Z[te]), 0, 1))), 3),
    }
    print(m)
    out = {
        "features": FEATURES, "mean": sc.mean_.tolist(), "scale": sc.scale_.tolist(),
        "clf_w": clf.coef_[0].tolist(), "clf_b": float(clf.intercept_[0]),
        "reg_w": reg.coef_.tolist(), "reg_b": float(reg.intercept_),
        "healthy": np.median(X[yh > 0.85], axis=0).tolist(), "metrics": m,
    }
    (ROOT / "frontend" / "model_lite.json").write_text(json.dumps(out))


if __name__ == "__main__":
    main()
