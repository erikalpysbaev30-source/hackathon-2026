"""Discrete-time simulator of an automotive assembly plant.

The simulator plays the role of the physical plant for the MVP: it produces the
same signals a real MES / SCADA / IoT gateway would deliver (station states,
sensor readings, part stocks, quality results). The digital twin layer
(KPIs, incidents, AI forecasts) only reads these signals, so the simulator can
be swapped for real data feeds without touching the rest of the system.
"""
from __future__ import annotations

import json
import math
import random
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "plant.json"

# Order of the main flow. Q3 routes defective cars to RW (rework), RW returns them to Q3.
FLOW = ["W1", "W2", "W3", "W4", "P1", "P2", "P3", "A1", "A2", "A3", "Q1", "Q2", "Q3", "L1"]

ACTIVE_STATES = {"working", "down", "maintenance", "no_parts"}
STATE_KEYS = ["working", "starved", "blocked", "down", "maintenance", "no_parts"]

DEFECT_TYPES = {
    "robot_weld": "weld_spot",
    "pretreat": "surface_prep",
    "paint_booth": "paint_run",
    "oven": "paint_cure",
    "trim": "trim_gap",
    "marriage": "torque",
    "final": "fluid_leak",
}
DEFECT_SHOP = {"weld_spot": "welding", "surface_prep": "paint", "paint_run": "paint", "paint_cure": "paint",
               "trim_gap": "assembly", "torque": "assembly", "fluid_leak": "assembly"}

# Breakdown causes per equipment type (named after the organizers' downtime records).
CAUSES = {
    "robot_weld": ["sensor_error", "servo_fault", "tip_wear"],
    "metrology": ["sensor_error", "camera_fault"],
    "pretreat": ["pump_fault", "sensor_error"],
    "paint_booth": ["filter_change", "atomizer_fault", "sensor_error"],
    "oven": ["burner_fault", "sensor_error"],
    "trim": ["chain_break", "drive_fault"],
    "marriage": ["chain_break", "drive_fault", "sensor_error"],
    "final": ["chain_break", "drive_fault"],
}


def load_config(path: Path = CONFIG_PATH) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@dataclass
class Car:
    id: int
    model: str
    defects: list = field(default_factory=list)
    reworked: bool = False
    inspected: bool = False


@dataclass
class Unit:
    car: Optional[Car] = None
    remaining: float = 0.0
    cycle: float = 0.0


class Station:
    def __init__(self, cfg: dict, baseline: dict):
        self.cfg = cfg
        self.id = cfg["id"]
        self.shop = cfg["shop"]
        self.type = cfg["type"]
        self.cycle = float(cfg["cycle"])
        self.units = [Unit() for _ in range(cfg.get("units", 1))]
        self.buffer: deque[Car] = deque()
        self.buffer_cap = cfg.get("buffer", 4)
        self.part = cfg.get("part")
        self.mtbf_s = cfg["mtbf_h"] * 3600.0
        self.mttr = cfg["mttr_min"]
        self.defect_rate = cfg.get("defect", 0.0)
        self.baseline = baseline
        self.is_sink = cfg.get("sink", False)

        self.health = 1.0
        self.wear_mult = 1.0
        self.defect_mult = 1.0
        self.defect_mult_until = 0.0
        self.state = "starved"
        self.repair_left = 0.0
        self.down_reason = None
        self.cause = None
        self.since_maint_s = 0.0
        self.down_day_s = 0.0  # stoppage time (breakdown + maintenance) in the current work day
        self.active_period = 0.0
        self.sensors = dict(baseline)
        self.sensor_hist: deque = deque(maxlen=60)   # one sample per sim-minute
        self.cycle_hist: deque = deque(maxlen=20)    # actual cycle times
        self.override_sensors: Optional[dict] = None  # filled by external telemetry
        self.reset_counters()

    def reset_counters(self):
        self.t_state = {k: 0.0 for k in STATE_KEYS}
        self.done = 0
        self.good = 0
        self.failures = 0
        self.busy_s = 0.0

    @property
    def free_slots(self) -> int:
        return self.buffer_cap - len(self.buffer)

    def wip(self) -> int:
        return len(self.buffer) + sum(1 for u in self.units if u.car)


class Plant:
    def __init__(self, cfg: Optional[dict] = None, seed: int = 7, start_hour: int = 8, warmup_h: float = 24.0):
        self.cfg = cfg or load_config()
        self.rng = random.Random(seed)
        self.dt = float(self.cfg["tick_seconds"])
        self.t = start_hour * 3600.0
        self.shift_len = self.cfg["shift_hours"] * 3600.0
        # the plant works shifts_per_day shifts from 08:00; the clock skips non-working hours
        self.workday = self.cfg.get("shifts_per_day", 3) * self.shift_len
        self.targets = self.cfg.get("targets", {})
        self.plan_per_shift = self.cfg["plan_per_shift"]
        self.stations: dict[str, Station] = {}
        for s in self.cfg["stations"]:
            self.stations[s["id"]] = Station(s, self.cfg["sensor_baseline"][s["type"]])
        self.next_of = {a: b for a, b in zip(FLOW, FLOW[1:])}
        self.parts = {p["id"]: dict(p, next_delivery=self.t + p["delivery_every_min"] * 60) for p in self.cfg["parts"]}
        self.supply_block: dict[str, float] = {}
        self.car_seq = 0
        self.models = self.cfg["models"]

        # KPI state
        self.shift_start = self._shift_start(self.t)
        self.day_no = self.work_day(self.t)
        self.produced_shift = 0
        self.produced_total = 0
        self.first_pass_ok = 0
        self.first_inspected = 0
        self.defects_found: dict[str, int] = {}
        self.escaped = 0
        self.completions: deque = deque()  # sim-times of accepted cars (rolling hour)
        self.history: deque = deque(maxlen=1440)
        self.bottleneck_hist: deque = deque(maxlen=720)  # per-minute momentary bottleneck ids
        self.events: list[dict] = []  # raw events consumed by the incident manager
        self._minute_acc = 0.0
        for st in self.stations.values():  # plant is not brand new: stagger equipment wear
            st.health = self.rng.uniform(0.45, 1.0)
            st.since_maint_s = (1 - st.health) * st.mtbf_s
        self.policy: Optional[Callable[["Plant"], None]] = None
        self.policy_every_s = 600.0
        self._policy_acc = 0.0
        self.downtime_log: list[dict] = []
        self.maint_log: list[dict] = []
        if warmup_h:
            self.run(warmup_h * 3600 + self.dt)
            self.events.clear()

    # ------------------------------------------------------------------ helpers
    SHIFT_OFFSET = 8 * 3600  # shift 1 starts at 08:00

    def _shift_start(self, t: float) -> float:
        o = self.SHIFT_OFFSET
        return math.floor((t - o) / self.shift_len) * self.shift_len + o

    def shift_no(self) -> int:
        return int(((self.t - self.SHIFT_OFFSET) % self.workday) // self.shift_len) + 1

    def work_day(self, t: float) -> int:
        return int((t - self.SHIFT_OFFSET) // self.workday)

    def calendar(self, t: Optional[float] = None) -> dict:
        """Plant time is working time only; map it to day number and wall-clock time."""
        t = self.t if t is None else t
        rel = t - self.SHIFT_OFFSET
        wall = self.SHIFT_OFFSET + rel % self.workday
        return {"t": t, "day": int(rel // self.workday) + 1, "hh": int(wall % 86400 // 3600), "mm": int(wall % 3600 // 60)}

    def emit(self, kind: str, station: Optional[str] = None, **params):
        self.events.append({"t": self.t, "kind": kind, "station": station, "params": params})

    def _new_car(self) -> Car:
        self.car_seq += 1
        r, acc = self.rng.random(), 0.0
        model = self.models[-1]["id"]
        for m in self.models:
            acc += m["mix"]
            if r <= acc:
                model = m["id"]
                break
        return Car(self.car_seq, model)

    # ------------------------------------------------------------------ physics
    def _hazard(self, st: Station) -> float:
        """Failure rate per second: grows exponentially as health degrades."""
        base = 1.0 / st.mtbf_s
        return base * (0.05 * math.exp(6.0 * (1.0 - st.health)))

    def _update_sensors(self, st: Station, load: float):
        b = st.baseline
        d = (1.0 - st.health)
        n = self.rng.gauss
        vib = b["vibration"] * (1 + 1.1 * d ** 1.5 + n(0, 0.05)) * (0.6 + 0.4 * load)
        temp = b["temperature"] * (1 + 0.18 * d ** 1.5 + n(0, 0.015))
        cur = b["current"] * (0.55 + 0.45 * load) * (1 + 0.3 * d ** 2 + n(0, 0.03))
        st.sensors = {"vibration": round(vib, 3), "temperature": round(temp, 2), "current": round(cur, 2)}
        if st.override_sensors:
            st.sensors.update(st.override_sensors)

    def _start_down(self, st: Station, reason: str, minutes: float):
        st.state = "down" if reason != "maintenance" else "maintenance"
        st.down_reason = reason
        st.repair_left = minutes * 60.0
        if reason == "maintenance":
            self.maint_log.append({"t": self.t, "station": st.id, "minutes": minutes})
        else:
            st.failures += 1
            st.cause = self.rng.choice(CAUSES.get(st.type, ["sensor_error"]))
            self.downtime_log.append({"t": self.t, "station": st.id, "minutes": minutes, "reason": reason, "cause": st.cause})
        self.emit("down", st.id, reason=reason, minutes=round(minutes), cause=None if reason == "maintenance" else st.cause)

    def force_failure(self, sid: str, minutes: Optional[float] = None, reason: str = "breakdown"):
        st = self.stations[sid]
        if st.state in ("down", "maintenance"):
            return
        self._start_down(st, reason, minutes or self.rng.uniform(*st.mttr))

    def schedule_maintenance(self, sid: str, minutes: float = 25.0) -> bool:
        st = self.stations[sid]
        if st.state in ("down", "maintenance"):
            return False
        self._start_down(st, "maintenance", minutes)
        return True

    def block_supply(self, part: str, hours: float):
        self.supply_block[part] = self.t + hours * 3600
        self.emit("supply_delay", None, part=part, hours=hours)

    # ------------------------------------------------------------------ main step
    def step(self):
        dt = self.dt
        self._supply()
        self._release_body()

        # process stations from the end of the line backwards so space frees up first
        for sid in reversed(FLOW + ["RW"]):
            self._step_station(self.stations[sid], dt)

        self._shift_rollover()
        self._minute_acc += dt
        if self._minute_acc >= 60:
            self._minute_acc -= 60
            self._sample_minute()
        if self.policy:
            self._policy_acc += dt
            if self._policy_acc >= self.policy_every_s:
                self._policy_acc = 0.0
                self.policy(self)
        self.t += dt

    def _supply(self):
        for pid, p in self.parts.items():
            if self.t >= p["next_delivery"]:
                p["next_delivery"] += p["delivery_every_min"] * 60
                if self.supply_block.get(pid, 0) > self.t:
                    self.emit("delivery_missed", None, part=pid)
                    continue
                p["stock"] = min(p["max"], p["stock"] + p["delivery_qty"])

    def _release_body(self):
        # body shop pulls a new car into W1 whenever there is space
        w1 = self.stations["W1"]
        if w1.free_slots > 0 and len(w1.buffer) < 2:
            w1.buffer.append(self._new_car())

    def _route(self, st: Station, car: Car) -> Optional[Station]:
        if st.id == "Q3":
            return self.stations["RW"] if car.defects else self.stations["L1"]
        if st.id == "RW":
            return self.stations["Q3"]
        nxt = self.next_of.get(st.id)
        return self.stations[nxt] if nxt else None

    def _finish_job(self, st: Station, u: Unit) -> bool:
        """Try to hand the finished car to the next station. Returns True if moved."""
        car = u.car
        nxt = self._route(st, car)
        if nxt is not None and nxt.free_slots <= 0:
            return False
        st.done += 1
        new_defect = False
        if st.defect_rate > 0:
            p = st.defect_rate * (1 + 3.0 * (1 - st.health)) * st.defect_mult
            if self.rng.random() < p:
                car.defects.append(DEFECT_TYPES.get(st.type, "other") + "@" + st.id)
                new_defect = True
        if not new_defect:
            st.good += 1
        if st.id == "Q3":
            self._inspect(car)
        if st.id == "RW":
            car.defects = []
            car.reworked = True
        st.cycle_hist.append(u.cycle)
        if nxt is not None:
            nxt.buffer.append(car)
        u.car = None
        return True

    def _inspect(self, car: Car):
        first = not car.inspected
        car.inspected = True
        detected = [d for d in car.defects if self.rng.random() < 0.95]
        escaped = [d for d in car.defects if d not in detected]
        if first:
            self.first_inspected += 1
            if not detected and not car.reworked:
                self.first_pass_ok += 1
        for d in detected:
            key = d.split("@")[0]
            self.defects_found[key] = self.defects_found.get(key, 0) + 1
            self.emit("defect", d.split("@")[1], defect=key, car=car.id)
        if detected:
            car.defects = detected
        else:
            if escaped:
                self.escaped += 1
            car.defects = []
            self.produced_shift += 1
            self.produced_total += 1
            self.completions.append(self.t)

    def _step_station(self, st: Station, dt: float):
        st.since_maint_s += dt
        if st.defect_mult != 1.0 and st.defect_mult_until and self.t > st.defect_mult_until:
            st.defect_mult, st.defect_mult_until = 1.0, 0.0
        if st.state in ("down", "maintenance"):
            st.down_day_s += dt
            st.repair_left -= dt
            st.t_state[st.state] += dt
            st.active_period += dt
            self._update_sensors(st, 0.0)
            if st.repair_left <= 0:
                was = st.state
                st.health = 1.0 if was == "maintenance" else self.rng.uniform(0.9, 1.0)
                st.since_maint_s = 0.0
                st.state = "starved"
                st.down_reason = None
                self.emit("up", st.id, after=was)
            return

        working = blocked = no_parts = 0
        for u in st.units:
            if u.car is not None and u.remaining <= 0:
                if not self._finish_job(st, u):
                    blocked += 1
                    continue
            if u.car is None and st.buffer:
                if st.part:
                    p = self.parts[st.part]
                    if p["stock"] <= 0:
                        no_parts += 1
                        continue
                    p["stock"] -= 1
                u.car = st.buffer.popleft()
                drift = 1 + 0.15 * (1 - st.health) ** 2
                u.cycle = st.cycle * drift * self.rng.uniform(0.97, 1.05)
                u.remaining = u.cycle
            if u.car is not None:
                u.remaining -= dt
                working += 1

        if st.is_sink:
            # yard: cars leave by truck, never blocks
            for u in st.units:
                if u.car is not None and u.remaining <= 0:
                    u.car = None

        idle = len(st.units) - working - blocked - no_parts
        if working and (idle == 0 or st.is_sink):
            state = "working"
        elif working and idle > 0 and not st.buffer:
            state = "starved"  # multi-unit station with a free unit: not a constraint right now
        elif blocked:
            state = "blocked"
        elif no_parts:
            state = "no_parts"
        else:
            state = "starved"
        if state == "no_parts" and st.state != "no_parts":
            self.emit("no_parts", st.id, part=st.part)
        st.state = state
        st.t_state[state] += dt
        st.active_period = st.active_period + dt if state in ACTIVE_STATES else 0.0

        load = working / len(st.units)
        st.busy_s += dt * load
        st.health = max(0.0, st.health - dt * load * st.wear_mult / (st.mtbf_s * 1.25))
        self._update_sensors(st, load)
        if working and self.rng.random() < 1 - math.exp(-self._hazard(st) * dt * load):
            self._start_down(st, "breakdown", self.rng.uniform(*st.mttr))

    def _shift_rollover(self):
        start = self._shift_start(self.t)
        if start != self.shift_start:
            self.emit("shift_end", None, produced=self.produced_shift, plan=self.plan_per_shift)
            day = self.work_day(self.t)
            if day != self.day_no:
                self.day_no = day
                for st in self.stations.values():
                    st.down_day_s = 0.0
                self.emit("day_end", None)
            self.shift_start = start
            self.produced_shift = 0
            self.first_pass_ok = self.first_inspected = 0
            self.defects_found = {}
            for st in self.stations.values():
                st.reset_counters()

    def momentary_bottleneck(self) -> str:
        cands = [s for s in self.stations.values() if s.id not in ("L1", "RW")]
        return max(cands, key=lambda s: s.active_period).id

    def _sample_minute(self):
        while self.completions and self.completions[0] < self.t - 3600:
            self.completions.popleft()
        for st in self.stations.values():
            st.sensor_hist.append((st.sensors["vibration"], st.sensors["temperature"], st.sensors["current"]))
        bn = self.momentary_bottleneck()
        self.bottleneck_hist.append(bn)
        k = self.kpis()
        self.history.append({
            "t": self.t,
            "jph": k["jph"],
            "produced": self.produced_shift,
            "plan_to_date": k["plan_to_date"],
            "oee": k["oee"],
            "fpy": k["fpy"],
            "wip": k["wip"],
            "bottleneck": bn,
            "down": sum(1 for s in self.stations.values() if s.state in ("down", "maintenance")),
        })

    # ------------------------------------------------------------------ KPIs
    def station_kpis(self, st: Station) -> dict:
        tot = sum(st.t_state.values()) or 1.0
        down = st.t_state["down"] + st.t_state["maintenance"]
        avail = 1 - down / tot
        op_time = max(tot - down, 1.0)
        perf = min(1.0, st.done * st.cycle / (op_time * len(st.units)))
        qual = st.good / st.done if st.done else 1.0
        return {
            "availability": round(avail, 3),
            "performance": round(perf, 3),
            "quality": round(qual, 3),
            "oee": round(avail * perf * qual, 3),
            "utilization": round(st.busy_s / tot, 3),
            "time": {k: round(v / 60, 1) for k, v in st.t_state.items()},
            "done": st.done,
            "failures": st.failures,
        }

    def ideal_cycle(self) -> float:
        return max(s.cycle / len(s.units) for s in self.stations.values() if s.id in FLOW and not s.is_sink)

    def kpis(self) -> dict:
        elapsed = max(self.t - self.shift_start, 1.0)
        bottleneck_cycle = self.ideal_cycle()
        plan_to_date = self.plan_per_shift * elapsed / self.shift_len
        downtime = sum(s.t_state["down"] for s in self.stations.values()) / 60
        insp = max(self.first_inspected, 1)
        by_shop = {"welding": 0, "paint": 0, "assembly": 0}
        for d, n in self.defects_found.items():
            if d in DEFECT_SHOP:
                by_shop[DEFECT_SHOP[d]] += n
        maint = sum(s.t_state["maintenance"] for s in self.stations.values()) / 60
        return {
            "produced": self.produced_shift,
            "plan": self.plan_per_shift,
            "plan_to_date": round(plan_to_date, 1),
            "attainment": round(self.produced_shift / plan_to_date, 3) if plan_to_date >= 5 else None,
            "jph": len(self.completions),
            # line OEE over the rolling hour: good cars x ideal bottleneck cycle / time
            "oee": round(min(1.0, len(self.completions) * bottleneck_cycle / 3600), 3),
            "fpy": round(self.first_pass_ok / self.first_inspected, 3) if self.first_inspected else 1.0,
            "wip": sum(s.wip() for s in self.stations.values() if not s.is_sink),
            "downtime_min": round(downtime, 1),
            "maintenance_min": round(maint, 1),
            "defects": dict(self.defects_found),
            "inspected": self.first_inspected,
            "defect_rate_by_shop": {k: round(v / insp, 4) for k, v in by_shop.items()},
            "shifts_per_day": round(self.workday / self.shift_len),
            "targets": self.targets,
            "rework_queue": self.stations["RW"].wip(),
            "shift": self.shift_no(),
            "shift_elapsed": round(elapsed / self.shift_len, 3),
        }

    def run(self, seconds: float):
        n = int(seconds / self.dt)
        for _ in range(n):
            self.step()
