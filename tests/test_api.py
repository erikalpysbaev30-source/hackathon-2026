import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def test_state_and_scenarios():
    with TestClient(app) as c:
        s = c.get("/api/state").json()
        assert len(s["stations"]) == 15 and "kpi" in s
        assert c.post("/api/scenario/robot_failure").json()["ok"]
        assert c.post("/api/maintenance/A2").status_code == 200
        assert c.post("/api/telemetry", json={"station": "A2", "vibration": 5.0}).json()["ok"]
        assert c.get("/api/metrics").json()["model"]["roc_auc"] > 0.6
        assert c.get("/").status_code == 200
