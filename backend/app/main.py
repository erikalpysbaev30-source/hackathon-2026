"""FastAPI server of the Allur digital twin MVP.

Run:  uvicorn app.main:app --port 8000   (from the backend/ folder)
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import time
from collections import Counter
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .incidents import IncidentManager
from .ml import MODEL_DIR, TwinAI
from .simulator import FLOW, Plant

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
SPEEDS = {"1": 0.1, "60": 6, "300": 30, "900": 90}  # sim ticks (10 s) per real second


class Twin:
    def __init__(self, seed: int = 7):
        self.ai = TwinAI()
        self.reset(seed)

    def reset(self, seed: int = 7):
        self.plant = Plant(seed=seed)
        self.incidents = IncidentManager()
        self.speed = "60"
        self.paused = False
        for st in self.plant.stations.values():  # surface stoppages already in progress
            if st.state in ("down", "maintenance"):
                self.plant.emit("down", st.id, reason="breakdown" if st.state == "down" else "maintenance",
                                minutes=round(st.repair_left / 60))
        self.assessment = self.ai.assess(self.plant)
        self.forecast = None
        self.recommendations = []
        self.forecast_at = 0.0
        self._tick_acc = 0.0
        self.scenario_log = []

    # ---------------------------------------------------------------- loop work
    def advance(self, real_dt: float):
        if self.paused:
            return
        self._tick_acc += SPEEDS[self.speed] * real_dt
        n = int(self._tick_acc)
        self._tick_acc -= n
        for _ in range(n):
            self.plant.step()
        fresh = self.ai.assess(self.plant)
        for sid, a in fresh.items():  # smooth risk so alerts do not flicker
            prev = self.assessment.get(sid)
            if prev and a["risk"] > 0:
                a["risk"] = round(0.8 * prev["risk"] + 0.2 * a["risk"], 3)
                a["level"] = "high" if a["risk"] >= 0.35 else "medium" if a["risk"] >= 0.18 else "low"
        self.assessment = fresh
        self.incidents.update(self.plant, self.assessment, self.forecast)

    def forecast_job(self):
        """Copy the plant on the loop thread, simulate the copy on a worker thread."""
        a = dict(self.assessment)
        snap = self.ai._clone(self.plant, a, seed=0)

        def job():
            return self.ai.forecast(snap, a, runs=16), self.ai.recommend(snap, a, top=3, runs=8, horizon_h=4.0)
        return job

    # ---------------------------------------------------------------- views
    def clock(self) -> dict:
        return self.plant.calendar()

    def snapshot(self) -> dict:
        p = self.plant
        bh = list(p.bottleneck_hist)[-120:]
        share = {k: round(v / len(bh), 3) for k, v in Counter(bh).most_common()} if bh else {}
        stations = []
        for sid in FLOW + ["RW"]:
            st = p.stations[sid]
            stations.append({
                "id": sid, "equip": st.cfg.get("equip"), "shop": st.shop, "type": st.type, "state": st.state,
                "cause": st.cause if st.state == "down" else None, "down_day_min": round(st.down_day_s / 60),
                "x": st.cfg["x"], "y": st.cfg["y"], "units": len(st.units),
                "busy": sum(1 for u in st.units if u.car), "buffer": len(st.buffer), "buffer_cap": st.buffer_cap,
                "sensors": st.sensors, "kpi": p.station_kpis(st), "cycle": st.cycle,
                "down_left_min": round(st.repair_left / 60) if st.state in ("down", "maintenance") else 0,
                "ai": self.assessment.get(sid),
            })
        return {
            "clock": self.clock(), "speed": self.speed, "paused": self.paused,
            "kpi": p.kpis(), "stations": stations,
            "parts": [{"id": k, "stock": v["stock"], "max": v["max"],
                       "blocked": p.supply_block.get(k, 0) > p.t,
                       "next_delivery_min": round((v["next_delivery"] - p.t) / 60)} for k, v in p.parts.items()],
            "bottleneck": {"now": p.momentary_bottleneck(), "share": share},
            "incidents": self.incidents.snapshot(),
            "forecast": self.forecast, "recommendations": self.recommendations,
            "shops": p.cfg["shops"],
        }


twin = Twin()
clients: set[WebSocket] = set()


async def sim_loop():
    last = time.monotonic()
    loop = asyncio.get_running_loop()
    forecast_task = None
    while True:
        await asyncio.sleep(0.2)
        now = time.monotonic()
        twin.advance(now - last)
        last = now
        if forecast_task is None and now - twin.forecast_at > 12:
            twin.forecast_at = now
            forecast_task = loop.run_in_executor(None, twin.forecast_job())
        if forecast_task is not None and forecast_task.done():
            try:
                twin.forecast, twin.recommendations = forecast_task.result()
            except Exception as exc:  # keep the twin alive if a forecast run fails
                print("forecast failed:", exc)
            forecast_task = None


async def broadcast_loop():
    while True:
        await asyncio.sleep(1.0)
        if not clients:
            continue
        msg = json.dumps(twin.snapshot())
        for ws in list(clients):
            try:
                await ws.send_text(msg)
            except Exception:
                clients.discard(ws)


@asynccontextmanager
async def lifespan(_app):
    tasks = [asyncio.create_task(sim_loop()), asyncio.create_task(broadcast_loop())]
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Allur Digital Twin", lifespan=lifespan)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    await ws.send_text(json.dumps(twin.snapshot()))
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        clients.discard(ws)


@app.get("/api/state")
def state():
    return twin.snapshot()


@app.get("/api/history")
def history(minutes: int = 480):
    return list(twin.plant.history)[-minutes:]


@app.get("/api/station/{sid}")
def station(sid: str):
    st = twin.plant.stations.get(sid)
    if not st:
        raise HTTPException(404)
    return {
        "id": sid, "sensor_hist": [list(h) for h in st.sensor_hist], "baseline": st.baseline,
        "ai": twin.assessment.get(sid), "kpi": twin.plant.station_kpis(st),
        "failures_log": [d for d in twin.plant.downtime_log if d["station"] == sid][-10:],
    }


class Speed(BaseModel):
    value: str


@app.post("/api/speed")
def set_speed(s: Speed):
    if s.value == "pause":
        twin.paused = not twin.paused
    elif s.value in SPEEDS:
        twin.speed, twin.paused = s.value, False
    else:
        raise HTTPException(400, "unknown speed")
    return {"speed": twin.speed, "paused": twin.paused}


SCENARIOS = {
    "robot_failure": lambda p: p.force_failure("W3", minutes=90),
    "supply_delay": lambda p: p.block_supply("engine", hours=4) or p.parts["engine"].update(stock=min(p.parts["engine"]["stock"], 10)),
    "paint_quality": lambda p: setattr(p.stations["P2"], "defect_mult", 6.0),
    "wear": lambda p: p.stations["A2"].__dict__.update(health=0.3, since_maint_s=1.1 * p.stations["A2"].mtbf_s),
}


@app.post("/api/scenario/{name}")
def scenario(name: str):
    if name == "reset":
        twin.reset()
        return {"ok": True}
    if name not in SCENARIOS:
        raise HTTPException(404)
    SCENARIOS[name](twin.plant)
    if name == "paint_quality":  # quality drift fades after 2 sim hours
        twin.plant.stations["P2"].defect_mult_until = twin.plant.t + 7200
    twin.scenario_log.append({"t": twin.plant.t, "name": name})
    twin.forecast_at = 0  # refresh forecast right away
    return {"ok": True}


@app.post("/api/maintenance/{sid}")
def maintenance(sid: str):
    if sid not in twin.plant.stations:
        raise HTTPException(404)
    ok = twin.plant.schedule_maintenance(sid)
    twin.forecast_at = 0
    return {"ok": ok}


@app.post("/api/incidents/{inc_id}/ack")
def ack(inc_id: int):
    return {"ok": twin.incidents.ack(inc_id)}


class Telemetry(BaseModel):
    station: str
    vibration: float | None = None
    temperature: float | None = None
    current: float | None = None


@app.post("/api/telemetry")
def telemetry(m: Telemetry):
    """Integration point for real sensors (OPC UA / MQTT gateway posts here)."""
    st = twin.plant.stations.get(m.station)
    if not st:
        raise HTTPException(404)
    vals = {k: v for k, v in m.model_dump().items() if k != "station" and v is not None}
    st.override_sensors = vals or None
    return {"ok": True, "override": st.override_sensors}


@app.get("/api/metrics")
def metrics():
    eff = MODEL_DIR / "effect.json"
    return {"model": twin.ai.metrics, "effect": json.loads(eff.read_text()) if eff.exists() else None}


@app.get("/api/export.csv", response_class=PlainTextResponse)
def export_csv():
    buf = io.StringIO()
    hist = list(twin.plant.history)
    if hist:
        w = csv.DictWriter(buf, fieldnames=list(hist[0].keys()))
        w.writeheader()
        w.writerows(hist)
    return buf.getvalue()


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND), name="static")
