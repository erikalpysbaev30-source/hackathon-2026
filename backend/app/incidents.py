"""Turns raw plant events and AI signals into operator-facing incidents."""
from __future__ import annotations

import itertools
from collections import deque

from .simulator import Plant

RISK_OPEN, RISK_CLOSE = 0.35, 0.20
LOW_STOCK, STOCK_OK = 8, 16


class IncidentManager:
    def __init__(self, maxlen: int = 300):
        self.items: deque[dict] = deque(maxlen=maxlen)
        self._ids = itertools.count(1)
        self._defects: deque = deque()

    def _open(self, plant: Plant, type_: str, severity: str, station=None, **params) -> dict:
        found = self.find_open(type_, station, params.get("part"))
        if found:
            found["params"].update(params)
            return found
        inc = {
            "id": next(self._ids), "t": plant.t, "type": type_, "severity": severity,
            "station": station, "params": params, "status": "open", "closed_t": None,
        }
        self.items.append(inc)
        return inc

    def find_open(self, type_, station=None, part=None):
        for inc in self.items:
            if inc["status"] != "closed" and inc["type"] == type_ and inc["station"] == station \
                    and inc["params"].get("part") == part:
                return inc
        return None

    def _close(self, plant: Plant, type_, station=None, part=None):
        inc = self.find_open(type_, station, part)
        if inc:
            inc["status"] = "closed"
            inc["closed_t"] = plant.t

    def ack(self, inc_id: int) -> bool:
        for inc in self.items:
            if inc["id"] == inc_id and inc["status"] == "open":
                inc["status"] = "ack"
                return True
        return False

    def update(self, plant: Plant, assessment: dict | None = None, forecast: dict | None = None):
        for e in plant.events:
            k, sid, p = e["kind"], e["station"], e["params"]
            if k == "down":
                if p["reason"] == "maintenance":
                    self._open(plant, "maintenance", "info", sid, minutes=p["minutes"])
                    self._close(plant, "failure_risk", sid)
                else:
                    self._open(plant, "breakdown", "critical", sid, minutes=p["minutes"])
                    self._close(plant, "failure_risk", sid)
            elif k == "up":
                self._close(plant, "breakdown" if p["after"] == "down" else "maintenance", sid)
            elif k == "no_parts":
                self._open(plant, "no_parts", "critical", sid, part=p["part"])
            elif k == "delivery_missed":
                self._open(plant, "delivery_missed", "warning", None, part=p["part"])
            elif k == "defect":
                self._defects.append((e["t"], p["defect"], sid))
            elif k == "shift_end":
                sev = "info" if p["produced"] >= p["plan"] else "warning"
                inc = self._open(plant, "shift_report", sev, None, produced=p["produced"], plan=p["plan"])
                inc["status"] = "closed"
                inc["closed_t"] = plant.t
        plant.events.clear()

        # resolve stock-outs and track low stock
        for st in plant.stations.values():
            if st.state != "no_parts":
                self._close(plant, "no_parts", st.id, st.part)
        for pid, part in plant.parts.items():
            if part["stock"] <= LOW_STOCK:
                self._open(plant, "low_stock", "warning", None, part=pid, stock=part["stock"])
            elif part["stock"] >= STOCK_OK:
                self._close(plant, "low_stock", None, pid)
            if part["stock"] >= STOCK_OK:
                self._close(plant, "delivery_missed", None, pid)

        # quality spikes: 3+ defects of the same type from the same station within an hour
        while self._defects and self._defects[0][0] < plant.t - 3600:
            self._defects.popleft()
        counts = {}
        for _, d, sid in self._defects:
            counts[(d, sid)] = counts.get((d, sid), 0) + 1
        for (d, sid), n in counts.items():
            if n >= 3:
                self._open(plant, "quality_spike", "warning", sid, defect=d, count=n)
        for inc in self.items:
            if inc["type"] == "quality_spike" and inc["status"] != "closed":
                if counts.get((inc["params"]["defect"], inc["station"]), 0) < 2:
                    inc["status"], inc["closed_t"] = "closed", plant.t

        if assessment:
            for sid, a in assessment.items():
                if a["risk"] >= RISK_OPEN:
                    self._open(plant, "failure_risk", "warning", sid, risk=a["risk"], health=a["health"],
                               drivers=[d["feature"] for d in a["drivers"]])
                elif a["risk"] < RISK_CLOSE:
                    self._close(plant, "failure_risk", sid)
        if forecast:
            if forecast["p_plan"] < 0.5 and plant.kpis()["shift_elapsed"] > 0.1:
                self._open(plant, "plan_risk", "warning", None, p_plan=forecast["p_plan"],
                           expected=forecast["expected_shift_total"], plan=forecast["plan"])
            elif forecast["p_plan"] >= 0.6:
                self._close(plant, "plan_risk")

    def snapshot(self, limit: int = 60) -> list[dict]:
        items = list(self.items)
        active = [i for i in items if i["status"] != "closed"]
        closed = [i for i in items if i["status"] == "closed"][-limit:]
        sev = {"critical": 0, "warning": 1, "info": 2}
        active.sort(key=lambda i: (sev[i["severity"]], -i["t"]))
        return active + closed[::-1]
