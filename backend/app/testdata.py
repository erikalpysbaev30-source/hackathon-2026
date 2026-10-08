"""Organizer test data (case 2): loading and the same KPI checks the dashboard shows.

The tables live in data/allur_test_data/*.csv (';'-separated, decimal comma allowed).
OEE per line and day = availability x performance x quality, where
  availability = run hours / shift hours,
  performance  = actual / (plan per hour x run hours), capped at 100 %,
  quality      = 1 - defects / released (from the quality table, same date and area).
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "allur_test_data"


def _num(x: str) -> float:
    return float(str(x).replace(",", ".").replace(" ", "").strip())


def _read(name: str) -> list[list[str]]:
    with open(DATA_DIR / name, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f, delimiter=";"))
    return rows[1:]


def area_of(line: str) -> str:
    return line.split("-")[0].strip()


def load() -> dict:
    return {
        "lines": [{"date": r[0], "line": r[1], "plan": _num(r[2]), "fact": _num(r[3]), "hours": _num(r[4]), "load": _num(r[5])}
                  for r in _read("lines.csv")],
        "downtime": [{"date": r[0], "area": r[1], "equip": r[2], "cause": r[3], "minutes": _num(r[4])}
                     for r in _read("downtime.csv")],
        "plan": [{"model": r[0], "qty": _num(r[1])} for r in _read("plan.csv")],
        "quality": [{"date": r[0], "area": r[1], "released": _num(r[2]), "defects": _num(r[3])}
                    for r in _read("quality.csv")],
        "targets": json.loads((DATA_DIR / "targets.json").read_text(encoding="utf-8")),
    }


def analyze(d: dict | None = None) -> dict:
    d = d or load()
    tg = d["targets"]
    sh = tg["shift_hours"]
    q = {(r["date"], r["area"]): r for r in d["quality"]}
    lines = []
    for r in d["lines"]:
        a = r["hours"] / sh
        perf = min(1.0, r["fact"] / (r["plan"] / sh * r["hours"])) if r["hours"] else 0.0
        qr = q.get((r["date"], area_of(r["line"])))
        qual = 1 - qr["defects"] / qr["released"] if qr and qr["released"] else 1.0
        oee = a * perf * qual
        lines.append(dict(r, availability=round(a, 4), performance=round(perf, 4), quality=round(qual, 4),
                          oee=round(oee, 4), ok=oee >= tg["oee_min"]))
    quality = [dict(r, rate=round(r["defects"] / r["released"], 4), ok=r["defects"] / r["released"] <= tg["defect_rate_max"])
               for r in d["quality"]]
    per_equip_day: dict[tuple, float] = {}
    for r in d["downtime"]:
        k = (r["date"], r["equip"])
        per_equip_day[k] = per_equip_day.get(k, 0) + r["minutes"]
    lim = tg["critical_downtime_min_per_day_max"]
    downtime = [{"date": k[0], "equip": k[1], "minutes": v, "ok": v <= lim, "near": 0.75 * lim <= v <= lim}
                for k, v in per_equip_day.items()]
    plan_total = sum(r["qty"] for r in d["plan"])
    final = [r for r in d["lines"] if area_of(r["line"]) == area_of(d["lines"][-1]["line"])]  # last area of the flow
    per_shift = sum(r["fact"] for r in final) / len(final) if final else 0
    days = tg["working_days_month"]
    run_rate = per_shift * tg["shifts_per_day"] * days
    need_per_shift = tg["plan_month_min"] / (tg["shifts_per_day"] * days)
    return {
        "lines": lines, "quality": quality, "downtime": downtime,
        "plan_total": plan_total, "plan_target": tg["plan_month_min"], "plan_gap": tg["plan_month_min"] - plan_total,
        "final_per_shift": round(per_shift, 1), "run_rate_month": round(run_rate), "need_per_shift": round(need_per_shift, 1),
        "line_plan_month": round(d["lines"][0]["plan"] * tg["shifts_per_day"] * days) if d["lines"] else 0,
        "oee_avg": round(sum(r["oee"] for r in lines) / len(lines), 4) if lines else None,
        "targets": tg,
    }


if __name__ == "__main__":
    print(json.dumps(analyze(), ensure_ascii=False, indent=2))
