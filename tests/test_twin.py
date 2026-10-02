import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.incidents import IncidentManager  # noqa: E402
from app.simulator import Plant  # noqa: E402


def test_plant_produces_cars_and_kpis_are_sane():
    p = Plant(seed=3)
    p.run(4 * 3600)
    k = p.kpis()
    assert k["produced"] > 20
    assert 0 <= k["oee"] <= 1 and 0 <= k["fpy"] <= 1
    assert set(k) >= {"jph", "wip", "downtime_min", "defects"}


def test_forced_failure_creates_and_closes_incident():
    p = Plant(seed=4)
    inc = IncidentManager()
    p.force_failure("W3", minutes=20)
    inc.update(p)
    assert any(i["type"] == "breakdown" and i["station"] == "W3" and i["status"] == "open" for i in inc.items)
    p.run(30 * 60)
    inc.update(p)
    assert all(i["status"] == "closed" for i in inc.items if i["type"] == "breakdown" and i["station"] == "W3")


def test_supply_block_starves_assembly():
    p = Plant(seed=5)
    p.parts["engine"]["stock"] = 0
    p.block_supply("engine", hours=3)
    p.run(2 * 3600)
    assert p.stations["A2"].t_state["no_parts"] > 0


def test_maintenance_restores_health():
    p = Plant(seed=6)
    st = p.stations["A2"]
    st.health = 0.3
    assert p.schedule_maintenance("A2", minutes=10)
    p.run(15 * 60)
    assert st.health > 0.9
