"""AI layer of the digital twin.

1. Health index regressor: estimates the hidden wear state of a machine (0..1)
   from what can actually be measured (vibration, temperature, current, cycle
   drift, time since maintenance).
2. Failure risk classifier: probability that a station breaks down within the
   next HORIZON_MIN minutes.
3. Monte-Carlo forecast: clones the plant, replaces the true (unknown) health
   with the AI estimate and simulates the rest of the shift many times to
   predict output, plan attainment, downtime and the coming bottleneck.
4. Prescriptive what-if: compares "do nothing" with "maintain station X now"
   and turns the difference into ranked recommendations.

Models are trained on synthetic history produced by the simulator. With real
Allur data the same pipeline is trained on MES / CMMS history instead.
"""
from __future__ import annotations

import copy
import json
import os

os.environ.setdefault("OMP_NUM_THREADS", "1")  # tiny batches: OpenMP thread spin-up costs more than it saves

import random
import statistics
from collections import Counter
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import average_precision_score, mean_absolute_error, roc_auc_score

from .simulator import FLOW, Plant, Station

HORIZON_MIN = 240
MODEL_DIR = Path(__file__).resolve().parent.parent / "models"
FEATURES = [
    "vib_ratio", "temp_ratio", "cur_ratio",
    "vib_ratio_15", "temp_ratio_15",
    "vib_slope", "temp_slope",
    "cycle_drift", "age_ratio",
]
FEATURE_LABELS = {  # i18n keys used by the UI
    "vib_ratio": "vibration", "vib_ratio_15": "vibration", "vib_slope": "vibration_trend",
    "temp_ratio": "temperature", "temp_ratio_15": "temperature", "temp_slope": "temperature_trend",
    "cur_ratio": "current", "cycle_drift": "cycle_drift", "age_ratio": "since_maintenance",
}


def features(st: Station) -> list[float]:
    b = st.baseline
    hist = list(st.sensor_hist)
    if hist:
        last = hist[-15:]
        vib15 = statistics.fmean(h[0] for h in last) / b["vibration"]
        temp15 = statistics.fmean(h[1] for h in last) / b["temperature"]
    else:
        vib15 = st.sensors["vibration"] / b["vibration"]
        temp15 = st.sensors["temperature"] / b["temperature"]
    if len(hist) >= 20:
        x = np.arange(len(hist))
        vib_slope = float(np.polyfit(x, [h[0] / b["vibration"] for h in hist], 1)[0]) * 60
        temp_slope = float(np.polyfit(x, [h[1] / b["temperature"] for h in hist], 1)[0]) * 60
    else:
        vib_slope = temp_slope = 0.0
    drift = (statistics.fmean(st.cycle_hist) / st.cycle) if st.cycle_hist else 1.0
    return [
        st.sensors["vibration"] / b["vibration"],
        st.sensors["temperature"] / b["temperature"],
        st.sensors["current"] / b["current"],
        vib15, temp15, vib_slope, temp_slope, drift,
        st.since_maint_s / st.mtbf_s,
    ]


def generate_dataset(seeds=(11, 12, 13, 14, 15, 16), days=8, sample_every_min=10):
    X, y_fail, y_health, groups = [], [], [], []
    for seed in seeds:
        plant = Plant(seed=seed)
        samples = []
        steps = int(sample_every_min * 60 / plant.dt)
        for i in range(int(days * 86400 / plant.dt)):
            plant.step()
            if i % steps == 0:
                for st in plant.stations.values():
                    if st.state in ("down", "maintenance") or st.is_sink:
                        continue
                    samples.append((st.id, plant.t, features(st), st.health))
        breakdowns = {}
        for d in plant.downtime_log:
            if d["reason"] == "breakdown":
                breakdowns.setdefault(d["station"], []).append(d["t"])
        for sid, t, f, h in samples:
            fut = any(t < bt <= t + HORIZON_MIN * 60 for bt in breakdowns.get(sid, []))
            X.append(f)
            y_fail.append(int(fut))
            y_health.append(h)
            groups.append(seed)
    return np.array(X), np.array(y_fail), np.array(y_health), np.array(groups)


def train(save: bool = True) -> dict:
    X, yf, yh, g = generate_dataset()
    test_seed = g.max()
    tr, te = g != test_seed, g == test_seed
    clf = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_leaf_nodes=15, random_state=0)
    clf.fit(X[tr], yf[tr])
    reg = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.05, random_state=0)
    reg.fit(X[tr], yh[tr])
    p = clf.predict_proba(X[te])[:, 1]
    base_rate = float(yf[te].mean())
    top = p >= np.quantile(p, 0.9)
    metrics = {
        "samples": int(len(X)),
        "positives_rate": round(float(yf.mean()), 4),
        "roc_auc": round(float(roc_auc_score(yf[te], p)), 3),
        "pr_auc": round(float(average_precision_score(yf[te], p)), 3),
        "lift_top10": round(float(yf[te][top].mean() / base_rate), 2) if base_rate else None,
        "recall_top10": round(float(yf[te][top].sum() / max(1, yf[te].sum())), 3),
        "health_mae": round(float(mean_absolute_error(yh[te], reg.predict(X[te]))), 3),
        "horizon_min": HORIZON_MIN,
    }
    # permutation-free importance proxy: average |feature - healthy median| weighted by gain is not
    # exposed by HGB, so we estimate importance by single-feature AUC instead (simple + explainable).
    imp = {}
    for i, name in enumerate(FEATURES):
        try:
            a = roc_auc_score(yf[te], X[te][:, i])
            imp[name] = round(abs(a - 0.5) * 2, 3)
        except ValueError:
            imp[name] = 0.0
    metrics["feature_signal"] = imp
    if save:
        MODEL_DIR.mkdir(exist_ok=True)
        joblib.dump({"clf": clf, "reg": reg, "healthy": np.median(X[yh > 0.85], axis=0).tolist()}, MODEL_DIR / "models.joblib")
        (MODEL_DIR / "metrics.json").write_text(json.dumps(metrics, indent=2))
    return metrics


class TwinAI:
    def __init__(self):
        path = MODEL_DIR / "models.joblib"
        try:
            m = joblib.load(path)
        except Exception:  # missing file or a scikit-learn version mismatch: retrain (about 2 minutes)
            train()
            m = joblib.load(path)
        self.clf, self.reg = m["clf"], m["reg"]
        self.healthy = np.array(m["healthy"])
        mp = MODEL_DIR / "metrics.json"
        self.metrics = json.loads(mp.read_text()) if mp.exists() else {}

    # ---------------------------------------------------------------- per-station
    def assess(self, plant: Plant) -> dict:
        ids = [s.id for s in plant.stations.values() if not s.is_sink]
        X = np.array([features(plant.stations[i]) for i in ids])
        risk = self.clf.predict_proba(X)[:, 1]
        health = np.clip(self.reg.predict(X), 0, 1)
        out = {}
        for i, sid in enumerate(ids):
            st = plant.stations[sid]
            dev = (X[i] - self.healthy) / np.maximum(np.abs(self.healthy), 1e-3)
            drivers = sorted([(FEATURES[j], float(dev[j])) for j in (3, 4, 2, 7)], key=lambda d: -d[1])[:2]
            if X[i][8] > 0.8:  # long time since the last maintenance
                drivers = [("age_ratio", float(X[i][8]))] + drivers[:1]
            r = float(risk[i]) if st.state not in ("down", "maintenance") else 0.0
            out[sid] = {
                "risk": round(r, 3),
                "health": round(float(health[i]), 3),
                "level": "high" if r >= 0.35 else "medium" if r >= 0.18 else "low",
                "drivers": [{"feature": FEATURE_LABELS[f], "deviation": round(v, 2)} for f, v in drivers],
            }
        return out

    # ---------------------------------------------------------------- simulation forecast
    def _clone(self, plant: Plant, assessment: dict, seed: int) -> Plant:
        events, hist, bh = plant.events, plant.history, plant.bottleneck_hist
        plant.events, plant.history, plant.bottleneck_hist = [], type(hist)(maxlen=1), type(bh)(maxlen=1)
        policy = plant.policy
        plant.policy = None
        try:
            c = copy.deepcopy(plant)
        finally:
            plant.events, plant.history, plant.bottleneck_hist, plant.policy = events, hist, bh, policy
        c.rng = random.Random(seed)
        c.history = type(hist)(maxlen=1440)
        c.bottleneck_hist = type(bh)(maxlen=2000)
        for sid, a in assessment.items():  # the twin does not know the true wear, only the AI estimate
            c.stations[sid].health = a["health"]
        return c

    def forecast(self, plant: Plant, assessment: dict, runs: int = 16, horizon_h: float | None = None,
                 action: tuple | None = None) -> dict:
        if horizon_h is None:
            horizon_h = max(0.5, (plant.shift_start + plant.shift_len - plant.t) / 3600)
        produced, down, bns = [], Counter(), Counter()
        first_station_down = Counter()
        for r in range(runs):
            c = self._clone(plant, assessment, seed=1000 + r)
            if action and action[0] == "maintenance":
                c.schedule_maintenance(action[1])
            start_total = c.produced_total
            n_dl = len(c.downtime_log)
            c.run(horizon_h * 3600)
            produced.append(c.produced_total - start_total)
            for d in c.downtime_log[n_dl:]:
                down[d["station"]] += d["minutes"] / runs
            if len(c.downtime_log) > n_dl:
                first_station_down[c.downtime_log[n_dl]["station"]] += 1
            bns.update(c.bottleneck_hist)
        produced_sorted = sorted(produced)
        need = max(0.0, plant.plan_per_shift - plant.produced_shift)
        q = lambda p: produced_sorted[min(len(produced_sorted) - 1, int(p * len(produced_sorted)))]
        tot_bn = sum(bns.values()) or 1
        return {
            "horizon_h": round(horizon_h, 2),
            "runs": runs,
            "expected_more": round(statistics.fmean(produced), 1),
            "p10": q(0.1), "p50": q(0.5), "p90": q(0.9),
            "expected_shift_total": round(plant.produced_shift + statistics.fmean(produced), 1),
            "plan": plant.plan_per_shift,
            "p_plan": round(sum(1 for p in produced if p >= need) / runs, 2),
            "expected_downtime": {k: round(v, 1) for k, v in down.most_common(5)},
            "bottleneck_share": {k: round(v / tot_bn, 3) for k, v in bns.most_common(5)},
        }

    def recommend(self, plant: Plant, assessment: dict, top: int = 3, runs: int = 12, horizon_h: float = 8.0):
        cands = sorted(
            [(sid, a) for sid, a in assessment.items() if a["risk"] >= 0.15 and plant.stations[sid].state not in ("down", "maintenance")],
            key=lambda x: -x[1]["risk"],
        )[:top]
        if not cands:
            return []
        base = self.forecast(plant, assessment, runs=runs, horizon_h=horizon_h)
        recs = []
        for sid, a in cands:
            alt = self.forecast(plant, assessment, runs=runs, horizon_h=horizon_h, action=("maintenance", sid))
            gain = alt["expected_more"] - base["expected_more"]
            saved = base["expected_downtime"].get(sid, 0) - alt["expected_downtime"].get(sid, 0)
            recs.append({
                "station": sid,
                "action": "maintenance",
                "risk": a["risk"],
                "gain_cars": round(gain, 1),
                "downtime_saved_min": round(saved, 1),
                "verdict": "do_now" if gain > 0.3 or (saved > 15 and gain > -0.5) else "plan_break" if gain > -1.0 else "monitor",
            })
        return sorted(recs, key=lambda r: -r["gain_cars"])


def predictive_policy(ai: TwinAI, threshold: float = 0.45, max_parallel: int = 1):  # noqa: D401
    """Maintenance policy used to quantify the business effect of the twin."""
    def policy(plant: Plant):
        busy = sum(1 for s in plant.stations.values() if s.state == "maintenance")
        if busy >= max_parallel:
            return
        a = ai.assess(plant)
        sid, best = max(a.items(), key=lambda kv: kv[1]["risk"])
        if best["risk"] >= threshold:
            plant.schedule_maintenance(sid)
    return policy


if __name__ == "__main__":
    print(json.dumps(train(), indent=2))
