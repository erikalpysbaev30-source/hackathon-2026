import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.incidents import IncidentManager  # noqa: E402
from app.simulator import Plant  # noqa: E402
from app.testdata import analyze  # noqa: E402


def test_organizer_data_checks():
    a = analyze()
    assert len(a["lines"]) == 6 and all(r["ok"] for r in a["lines"])          # OEE >= 85 % everywhere
    bad_q = {(r["date"], r["area"]) for r in a["quality"] if not r["ok"]}
    assert bad_q == {("01.10.2026", "Окраска"), ("02.10.2026", "Окраска"), ("02.10.2026", "Сварка")}
    assert a["plan_total"] == 4800 and a["plan_gap"] == 700
    assert any(r["near"] for r in a["downtime"]) and all(r["ok"] for r in a["downtime"])


def test_two_shift_calendar():
    p = Plant(seed=3, warmup_h=0)
    assert p.calendar() == {"t": 8 * 3600, "day": 1, "hh": 8, "mm": 0} and p.shift_no() == 1
    p.run(8 * 3600 + p.dt)
    assert p.shift_no() == 2
    p.run(8 * 3600)
    c = p.calendar()
    assert (c["day"], c["hh"], p.shift_no()) == (2, 8, 1)  # night is skipped: day 2 starts at 08:00


def test_daily_downtime_limit_incident():
    p = Plant(seed=3, warmup_h=0)
    im = IncidentManager()
    p.force_failure("W3", minutes=90)
    p.run(70 * 60)
    im.update(p)
    assert im.find_open("downtime_limit", "W3") is not None
