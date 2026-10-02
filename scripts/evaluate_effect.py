"""Quantify the business effect of the digital twin on simulated history.

Compares two maintenance policies on identical random seeds:
  * reactive   - repair after breakdown (today's practice);
  * predictive - the twin's AI schedules a short planned maintenance when the
                 predicted failure risk for the next 2 hours is high.

Usage:  python scripts/evaluate_effect.py [days] [seeds]
Writes backend/models/effect.json used by the dashboard and the slides.
"""
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.ml import MODEL_DIR, TwinAI, predictive_policy  # noqa: E402
from app.simulator import Plant  # noqa: E402


def run(policy_factory, seed, days):
    p = Plant(seed=seed)
    if policy_factory:
        p.policy = policy_factory()
    start_t, start_n = p.t, p.produced_total
    n_dl, n_m = len(p.downtime_log), len(p.maint_log)
    ends = []
    for _ in range(int(days * 24)):
        p.run(3600)
        ends += [e["params"] for e in p.events if e["kind"] == "shift_end"]
        p.events.clear()
    shifts = max(1, len(ends))
    shifts_ok = sum(1 for e in ends if e["produced"] >= e["plan"])
    hours = (p.t - start_t) / 3600
    breakdowns = p.downtime_log[n_dl:]
    return {
        "cars": p.produced_total - start_n,
        "jph": (p.produced_total - start_n) / hours,
        "breakdowns": len(breakdowns),
        "breakdown_min": sum(d["minutes"] for d in breakdowns),
        "maintenance_min": sum(m["minutes"] for m in p.maint_log[n_m:]),
        "plan_hit": shifts_ok / shifts,
    }


THRESHOLD = float(sys.argv[3]) if len(sys.argv) > 3 else 0.35


def main():
    days = float(sys.argv[1]) if len(sys.argv) > 1 else 10
    seeds = range(101, 101 + (int(sys.argv[2]) if len(sys.argv) > 2 else 4))
    ai = TwinAI()
    res = {"days_per_seed": days, "seeds": len(seeds)}
    for name, factory in [("reactive", None), ("predictive", lambda: predictive_policy(ai, threshold=THRESHOLD))]:
        rows = [run(factory, s, days) for s in seeds]
        res[name] = {k: round(statistics.fmean(r[k] for r in rows), 3) for k in rows[0]}
        print(name, res[name], flush=True)
    r, p = res["reactive"], res["predictive"]
    res["delta"] = {
        "breakdown_min_pct": round(100 * (p["breakdown_min"] - r["breakdown_min"]) / r["breakdown_min"], 1),
        "breakdowns_pct": round(100 * (p["breakdowns"] - r["breakdowns"]) / r["breakdowns"], 1),
        "output_pct": round(100 * (p["cars"] - r["cars"]) / r["cars"], 2),
        "extra_cars_per_day": round((p["cars"] - r["cars"]) / days, 2),
        "plan_hit_pp": round(100 * (p["plan_hit"] - r["plan_hit"]), 1),
    }
    print(json.dumps(res["delta"], indent=2))
    res["threshold"] = THRESHOLD
    out = sys.argv[4] if len(sys.argv) > 4 else MODEL_DIR / "effect.json"
    Path(out).write_text(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
