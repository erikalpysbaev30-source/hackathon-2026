/* In-browser twin engine: a JavaScript port of backend/app/{simulator,ml,incidents}.py.
   Used by the static demo (no server). Exposes window.LocalTwin with the same data the API returns. */
(function () {
  const FLOW = ["W1", "W2", "W3", "W4", "P1", "P2", "P3", "A1", "A2", "A3", "Q1", "Q2", "Q3", "L1"];
  const ORDER = FLOW.concat(["RW"]);
  const ACTIVE = new Set(["working", "down", "maintenance", "no_parts"]);
  const STATES = ["working", "starved", "blocked", "down", "maintenance", "no_parts"];
  const DEFECT_TYPES = { robot_weld: "weld_spot", pretreat: "surface_prep", paint_booth: "paint_run", oven: "paint_cure", trim: "trim_gap", marriage: "torque", final: "fluid_leak" };
  const SHIFT_OFFSET = 8 * 3600;

  // seeded RNG (mulberry32) whose whole state is one integer, so a plant clones with structuredClone
  function rand(p) {
    let t = (p.seed = (p.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const uniform = (p, a, b) => a + (b - a) * rand(p);
  function gauss(p, mu, sd) {
    const u = Math.max(rand(p), 1e-12), v = rand(p);
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

  function newTState() { return Object.fromEntries(STATES.map((k) => [k, 0])); }

  function createPlant(cfg, seed = 7, startHour = 8, warmupH = 24) {
    const p = {
      cfg, seed: seed * 2654435761 | 0, dt: cfg.tick_seconds, t: startHour * 3600, shiftLen: cfg.shift_hours * 3600,
      plan: cfg.plan_per_shift, stations: {}, parts: {}, supplyBlock: {}, carSeq: 0,
      producedShift: 0, producedTotal: 0, firstOk: 0, firstInspected: 0, defectsFound: {},
      completions: [], history: [], bnHist: [], events: [], minuteAcc: 0, downtimeLog: [], maintLog: [],
    };
    for (const s of cfg.stations) {
      p.stations[s.id] = {
        id: s.id, shop: s.shop, type: s.type, cycle: s.cycle, nUnits: s.units || 1, x: s.x, y: s.y,
        units: Array.from({ length: s.units || 1 }, () => ({ car: null, remaining: 0, cycle: 0 })),
        buffer: [], bufferCap: s.buffer || 4, part: s.part || null, mtbf: s.mtbf_h * 3600, mttr: s.mttr_min,
        defectRate: s.defect || 0, baseline: cfg.sensor_baseline[s.type], sink: !!s.sink,
        health: 1, wearMult: 1, defectMult: 1, defectUntil: 0, state: "starved", repairLeft: 0, sinceMaint: 0,
        activePeriod: 0, sensors: Object.assign({}, cfg.sensor_baseline[s.type]), sensorHist: [], cycleHist: [],
        tState: newTState(), done: 0, good: 0, failures: 0, busy: 0,
      };
    }
    for (const pt of cfg.parts) p.parts[pt.id] = Object.assign({}, pt, { nextDelivery: p.t + pt.delivery_every_min * 60 });
    p.shiftStart = shiftStart(p, p.t);
    for (const st of Object.values(p.stations)) {
      st.health = uniform(p, 0.45, 1.0);
      st.sinceMaint = (1 - st.health) * st.mtbf;
    }
    if (warmupH) { run(p, warmupH * 3600 + p.dt); p.events = []; }
    return p;
  }

  function shiftStart(p, t) { return Math.floor((t - SHIFT_OFFSET) / p.shiftLen) * p.shiftLen + SHIFT_OFFSET; }
  function shiftNo(p) { return Math.floor((((p.t - SHIFT_OFFSET) % 86400) + 86400) % 86400 / p.shiftLen) + 1; }
  function emit(p, kind, station, params) { p.events.push({ t: p.t, kind, station, params: params || {} }); }
  const wip = (st) => st.buffer.length + st.units.filter((u) => u.car).length;

  function newCar(p) {
    p.carSeq += 1;
    const x = rand(p);
    let acc = 0, model = p.cfg.models[p.cfg.models.length - 1].id;
    for (const m of p.cfg.models) { acc += m.mix; if (x <= acc) { model = m.id; break; } }
    return { id: p.carSeq, model, defects: [], reworked: false, inspected: false };
  }

  function hazard(st) { return (1 / st.mtbf) * 0.05 * Math.exp(6 * (1 - st.health)); }

  function updateSensors(p, st, load) {
    const b = st.baseline, d = 1 - st.health;
    const vib = b.vibration * (1 + 1.1 * d ** 1.5 + gauss(p, 0, 0.05)) * (0.6 + 0.4 * load);
    const temp = b.temperature * (1 + 0.18 * d ** 1.5 + gauss(p, 0, 0.015));
    const cur = b.current * (0.55 + 0.45 * load) * (1 + 0.3 * d ** 2 + gauss(p, 0, 0.03));
    st.sensors = { vibration: r(vib, 3), temperature: r(temp, 2), current: r(cur, 2) };
  }

  function startDown(p, st, reason, minutes) {
    st.state = reason === "maintenance" ? "maintenance" : "down";
    st.repairLeft = minutes * 60;
    if (reason === "maintenance") p.maintLog.push({ t: p.t, station: st.id, minutes });
    else { st.failures += 1; p.downtimeLog.push({ t: p.t, station: st.id, minutes, reason }); }
    emit(p, "down", st.id, { reason, minutes: Math.round(minutes) });
  }
  function forceFailure(p, sid, minutes) {
    const st = p.stations[sid];
    if (st.state === "down" || st.state === "maintenance") return;
    startDown(p, st, "breakdown", minutes || uniform(p, st.mttr[0], st.mttr[1]));
  }
  function scheduleMaintenance(p, sid, minutes = 25) {
    const st = p.stations[sid];
    if (st.state === "down" || st.state === "maintenance") return false;
    startDown(p, st, "maintenance", minutes);
    return true;
  }
  function blockSupply(p, part, hours) { p.supplyBlock[part] = p.t + hours * 3600; emit(p, "supply_delay", null, { part, hours }); }

  function step(p) {
    const dt = p.dt;
    for (const [pid, pt] of Object.entries(p.parts)) {
      if (p.t >= pt.nextDelivery) {
        pt.nextDelivery += pt.delivery_every_min * 60;
        if ((p.supplyBlock[pid] || 0) > p.t) { emit(p, "delivery_missed", null, { part: pid }); continue; }
        pt.stock = Math.min(pt.max, pt.stock + pt.delivery_qty);
      }
    }
    const w1 = p.stations.W1;
    if (w1.bufferCap - w1.buffer.length > 0 && w1.buffer.length < 2) w1.buffer.push(newCar(p));
    for (let i = ORDER.length - 1; i >= 0; i--) stepStation(p, p.stations[ORDER[i]], dt);
    const s = shiftStart(p, p.t);
    if (s !== p.shiftStart) {
      emit(p, "shift_end", null, { produced: p.producedShift, plan: p.plan });
      p.shiftStart = s; p.producedShift = 0; p.firstOk = p.firstInspected = 0; p.defectsFound = {};
      for (const st of Object.values(p.stations)) { st.tState = newTState(); st.done = st.good = st.failures = 0; st.busy = 0; }
    }
    p.minuteAcc += dt;
    if (p.minuteAcc >= 60) { p.minuteAcc -= 60; sampleMinute(p); }
    p.t += dt;
  }

  function route(p, st, car) {
    if (st.id === "Q3") return car.defects.length ? p.stations.RW : p.stations.L1;
    if (st.id === "RW") return p.stations.Q3;
    const i = FLOW.indexOf(st.id);
    return i >= 0 && i < FLOW.length - 1 ? p.stations[FLOW[i + 1]] : null;
  }

  function finishJob(p, st, u) {
    const car = u.car, nxt = route(p, st, car);
    if (nxt && nxt.bufferCap - nxt.buffer.length <= 0) return false;
    st.done += 1;
    let newDefect = false;
    if (st.defectRate > 0) {
      const pr = st.defectRate * (1 + 3 * (1 - st.health)) * st.defectMult;
      if (rand(p) < pr) { car.defects.push((DEFECT_TYPES[st.type] || "other") + "@" + st.id); newDefect = true; }
    }
    if (!newDefect) st.good += 1;
    if (st.id === "Q3") inspect(p, car);
    if (st.id === "RW") { car.defects = []; car.reworked = true; }
    st.cycleHist.push(u.cycle); if (st.cycleHist.length > 20) st.cycleHist.shift();
    if (nxt) nxt.buffer.push(car);
    u.car = null;
    return true;
  }

  function inspect(p, car) {
    const first = !car.inspected;
    car.inspected = true;
    const detected = car.defects.filter(() => rand(p) < 0.95);
    if (first) { p.firstInspected += 1; if (!detected.length && !car.reworked) p.firstOk += 1; }
    for (const d of detected) {
      const [key, sid] = d.split("@");
      p.defectsFound[key] = (p.defectsFound[key] || 0) + 1;
      emit(p, "defect", sid, { defect: key, car: car.id });
    }
    if (detected.length) car.defects = detected;
    else { car.defects = []; p.producedShift += 1; p.producedTotal += 1; p.completions.push(p.t); }
  }

  function stepStation(p, st, dt) {
    st.sinceMaint += dt;
    if (st.defectMult !== 1 && st.defectUntil && p.t > st.defectUntil) { st.defectMult = 1; st.defectUntil = 0; }
    if (st.state === "down" || st.state === "maintenance") {
      st.repairLeft -= dt; st.tState[st.state] += dt; st.activePeriod += dt;
      updateSensors(p, st, 0);
      if (st.repairLeft <= 0) {
        const was = st.state;
        st.health = was === "maintenance" ? 1 : uniform(p, 0.9, 1.0);
        st.sinceMaint = 0; st.state = "starved";
        emit(p, "up", st.id, { after: was });
      }
      return;
    }
    let working = 0, blocked = 0, noParts = 0;
    for (const u of st.units) {
      if (u.car && u.remaining <= 0) { if (!finishJob(p, st, u)) { blocked += 1; continue; } }
      if (!u.car && st.buffer.length) {
        if (st.part) {
          const pt = p.parts[st.part];
          if (pt.stock <= 0) { noParts += 1; continue; }
          pt.stock -= 1;
        }
        u.car = st.buffer.shift();
        u.cycle = st.cycle * (1 + 0.15 * (1 - st.health) ** 2) * uniform(p, 0.97, 1.05);
        u.remaining = u.cycle;
      }
      if (u.car) { u.remaining -= dt; working += 1; }
    }
    if (st.sink) for (const u of st.units) if (u.car && u.remaining <= 0) u.car = null;
    const idle = st.units.length - working - blocked - noParts;
    let state;
    if (working && (idle === 0 || st.sink)) state = "working";
    else if (working && idle > 0 && !st.buffer.length) state = "starved";
    else if (blocked) state = "blocked";
    else if (noParts) state = "no_parts";
    else state = "starved";
    if (state === "no_parts" && st.state !== "no_parts") emit(p, "no_parts", st.id, { part: st.part });
    st.state = state;
    st.tState[state] += dt;
    st.activePeriod = ACTIVE.has(state) ? st.activePeriod + dt : 0;
    const load = working / st.units.length;
    st.busy += dt * load;
    st.health = Math.max(0, st.health - dt * load * st.wearMult / (st.mtbf * 1.25));
    updateSensors(p, st, load);
    if (working && rand(p) < 1 - Math.exp(-hazard(st) * dt * load)) startDown(p, st, "breakdown", uniform(p, st.mttr[0], st.mttr[1]));
  }

  function momentaryBottleneck(p) {
    let best = null;
    for (const st of Object.values(p.stations)) {
      if (st.id === "L1" || st.id === "RW") continue;
      if (!best || st.activePeriod > best.activePeriod) best = st;
    }
    return best.id;
  }

  function sampleMinute(p) {
    while (p.completions.length && p.completions[0] < p.t - 3600) p.completions.shift();
    for (const st of Object.values(p.stations)) {
      st.sensorHist.push([st.sensors.vibration, st.sensors.temperature, st.sensors.current]);
      if (st.sensorHist.length > 60) st.sensorHist.shift();
    }
    const bn = momentaryBottleneck(p);
    p.bnHist.push(bn); if (p.bnHist.length > 720) p.bnHist.shift();
    if (p.noHistory) return;
    const k = kpis(p);
    p.history.push({ t: p.t, jph: k.jph, produced: p.producedShift, plan_to_date: k.plan_to_date, oee: k.oee, fpy: k.fpy, wip: k.wip, bottleneck: bn });
    if (p.history.length > 1440) p.history.shift();
  }

  function stationKpis(st) {
    const tot = Object.values(st.tState).reduce((a, b) => a + b, 0) || 1;
    const down = st.tState.down + st.tState.maintenance;
    const avail = 1 - down / tot, op = Math.max(tot - down, 1);
    const perf = Math.min(1, st.done * st.cycle / (op * st.units.length));
    const qual = st.done ? st.good / st.done : 1;
    return {
      availability: r(avail, 3), performance: r(perf, 3), quality: r(qual, 3), oee: r(avail * perf * qual, 3),
      utilization: r(st.busy / tot, 3), time: Object.fromEntries(Object.entries(st.tState).map(([k, v]) => [k, r(v / 60, 1)])),
      done: st.done, failures: st.failures,
    };
  }

  function idealCycle(p) {
    let m = 0;
    for (const id of FLOW) { const s = p.stations[id]; if (!s.sink) m = Math.max(m, s.cycle / s.units.length); }
    return m;
  }

  function kpis(p) {
    const elapsed = Math.max(p.t - p.shiftStart, 1), ptd = p.plan * elapsed / p.shiftLen;
    const sts = Object.values(p.stations);
    return {
      produced: p.producedShift, plan: p.plan, plan_to_date: r(ptd, 1),
      attainment: ptd >= 5 ? r(p.producedShift / ptd, 3) : null,
      jph: p.completions.length, oee: r(Math.min(1, p.completions.length * idealCycle(p) / 3600), 3),
      fpy: p.firstInspected ? r(p.firstOk / p.firstInspected, 3) : 1,
      wip: sts.filter((s) => !s.sink).reduce((a, s) => a + wip(s), 0),
      downtime_min: r(sts.reduce((a, s) => a + s.tState.down, 0) / 60, 1),
      maintenance_min: r(sts.reduce((a, s) => a + s.tState.maintenance, 0) / 60, 1),
      defects: Object.assign({}, p.defectsFound), rework_queue: wip(p.stations.RW), shift: shiftNo(p),
      shift_elapsed: r(elapsed / p.shiftLen, 3),
    };
  }

  function run(p, seconds) { const n = Math.floor(seconds / p.dt); for (let i = 0; i < n; i++) step(p); }

  // ---------------------------------------------------------------- AI (logistic + ridge on quadratic features)
  const FEATURE_LABELS = ["vibration", "temperature", "current", "vibration", "temperature", "vibration_trend", "temperature_trend", "cycle_drift", "since_maintenance"];
  function slope(ys) {
    const n = ys.length, mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    ys.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
    return den ? num / den : 0;
  }
  function features(st) {
    const b = st.baseline, h = st.sensorHist;
    let vib15, temp15;
    if (h.length) {
      const last = h.slice(-15);
      vib15 = last.reduce((a, x) => a + x[0], 0) / last.length / b.vibration;
      temp15 = last.reduce((a, x) => a + x[1], 0) / last.length / b.temperature;
    } else { vib15 = st.sensors.vibration / b.vibration; temp15 = st.sensors.temperature / b.temperature; }
    const vs = h.length >= 20 ? slope(h.map((x) => x[0] / b.vibration)) * 60 : 0;
    const ts = h.length >= 20 ? slope(h.map((x) => x[1] / b.temperature)) * 60 : 0;
    const drift = st.cycleHist.length ? st.cycleHist.reduce((a, c) => a + c, 0) / st.cycleHist.length / st.cycle : 1;
    return [st.sensors.vibration / b.vibration, st.sensors.temperature / b.temperature, st.sensors.current / b.current, vib15, temp15, vs, ts, drift, st.sinceMaint / st.mtbf];
  }
  function assess(M, p) {
    const out = {};
    for (const st of Object.values(p.stations)) {
      if (st.sink) continue;
      const x = features(st);
      const z = x.map((v, i) => (v - M.mean[i]) / M.scale[i]);
      const zz = z.concat(z.map((v) => v * v));
      const lin = zz.reduce((a, v, i) => a + v * M.clf_w[i], M.clf_b);
      let risk = 1 / (1 + Math.exp(-lin));
      const health = Math.min(1, Math.max(0, zz.reduce((a, v, i) => a + v * M.reg_w[i], M.reg_b)));
      if (st.state === "down" || st.state === "maintenance") risk = 0;
      const dev = x.map((v, i) => (v - M.healthy[i]) / Math.max(Math.abs(M.healthy[i]), 1e-3));
      let drivers = [3, 4, 2, 7].map((j) => [FEATURE_LABELS[j], dev[j]]).sort((a, b) => b[1] - a[1]).slice(0, 2);
      if (x[8] > 0.8) drivers = [["since_maintenance", x[8]]].concat(drivers.slice(0, 1));
      out[st.id] = {
        risk: r(risk, 3), health: r(health, 3), level: risk >= 0.35 ? "high" : risk >= 0.18 ? "medium" : "low",
        drivers: drivers.map(([f, v]) => ({ feature: f, deviation: r(v, 2) })),
      };
    }
    return out;
  }

  function clone(p, a, seed) {
    const keep = { history: p.history, events: p.events };
    p.history = []; p.events = [];
    const c = structuredClone(p);
    Object.assign(p, keep);
    c.seed = seed; c.noHistory = true; c.bnHist = [];
    for (const [sid, x] of Object.entries(a)) c.stations[sid].health = x.health; // the twin only knows the AI estimate
    return c;
  }

  function forecast(p, a, runs = 16, horizonH = null, action = null) {
    if (horizonH == null) horizonH = Math.max(0.5, (p.shiftStart + p.shiftLen - p.t) / 3600);
    const produced = [], down = {}, bns = {};
    for (let i = 0; i < runs; i++) {
      const c = clone(p, a, 1000 + i * 7919);
      if (action) scheduleMaintenance(c, action);
      const s0 = c.producedTotal, n0 = c.downtimeLog.length;
      run(c, horizonH * 3600);
      produced.push(c.producedTotal - s0);
      for (const d of c.downtimeLog.slice(n0)) down[d.station] = (down[d.station] || 0) + d.minutes / runs;
      for (const b of c.bnHist) bns[b] = (bns[b] || 0) + 1;
    }
    const sorted = produced.slice().sort((x, y) => x - y);
    const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
    const need = Math.max(0, p.plan - p.producedShift);
    const mean = produced.reduce((x, y) => x + y, 0) / runs;
    const totBn = Object.values(bns).reduce((x, y) => x + y, 0) || 1;
    const top = (o, n) => Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, n);
    return {
      horizon_h: r(horizonH, 2), runs, expected_more: r(mean, 1), p10: q(0.1), p50: q(0.5), p90: q(0.9),
      expected_shift_total: r(p.producedShift + mean, 1), plan: p.plan,
      p_plan: r(produced.filter((x) => x >= need).length / runs, 2),
      expected_downtime: Object.fromEntries(top(down, 5).map(([k, v]) => [k, r(v, 1)])),
      bottleneck_share: Object.fromEntries(top(bns, 5).map(([k, v]) => [k, r(v / totBn, 3)])),
    };
  }

  function recommend(p, a) {
    const cands = Object.entries(a).filter(([sid, x]) => x.risk >= 0.15 && !["down", "maintenance"].includes(p.stations[sid].state))
      .sort((x, y) => y[1].risk - x[1].risk).slice(0, 3);
    if (!cands.length) return [];
    const base = forecast(p, a, 8, 4);
    return cands.map(([sid, x]) => {
      const alt = forecast(p, a, 8, 4, sid);
      const gain = alt.expected_more - base.expected_more;
      const saved = (base.expected_downtime[sid] || 0) - (alt.expected_downtime[sid] || 0);
      return { station: sid, action: "maintenance", risk: x.risk, gain_cars: r(gain, 1), downtime_saved_min: r(saved, 1),
        verdict: gain > 0.3 || (saved > 15 && gain > -0.5) ? "do_now" : gain > -1 ? "plan_break" : "monitor" };
    }).sort((x, y) => y.gain_cars - x.gain_cars);
  }

  // ---------------------------------------------------------------- incidents
  function createIncidents() { return { items: [], seq: 1, defects: [] }; }
  function findOpen(im, type, station = null, part = null) {
    return im.items.find((i) => i.status !== "closed" && i.type === type && i.station === station && (i.params.part ?? null) === part);
  }
  function openInc(im, p, type, severity, station, params) {
    const f = findOpen(im, type, station, params.part ?? null);
    if (f) { Object.assign(f.params, params); return f; }
    const inc = { id: im.seq++, t: p.t, type, severity, station, params, status: "open", closed_t: null };
    im.items.push(inc); if (im.items.length > 300) im.items.shift();
    return inc;
  }
  function closeInc(im, p, type, station = null, part = null) {
    const f = findOpen(im, type, station, part);
    if (f) { f.status = "closed"; f.closed_t = p.t; }
  }
  function updateIncidents(im, p, a, f) {
    for (const e of p.events) {
      const { kind: k, station: sid, params: pr } = e;
      if (k === "down") {
        if (pr.reason === "maintenance") openInc(im, p, "maintenance", "info", sid, { minutes: pr.minutes });
        else openInc(im, p, "breakdown", "critical", sid, { minutes: pr.minutes });
        closeInc(im, p, "failure_risk", sid);
      } else if (k === "up") closeInc(im, p, pr.after === "down" ? "breakdown" : "maintenance", sid);
      else if (k === "no_parts") openInc(im, p, "no_parts", "critical", sid, { part: pr.part });
      else if (k === "delivery_missed") openInc(im, p, "delivery_missed", "warning", null, { part: pr.part });
      else if (k === "defect") im.defects.push([e.t, pr.defect, sid]);
      else if (k === "shift_end") {
        const inc = openInc(im, p, "shift_report", pr.produced >= pr.plan ? "info" : "warning", null, { produced: pr.produced, plan: pr.plan });
        inc.status = "closed"; inc.closed_t = p.t;
      }
    }
    p.events = [];
    for (const st of Object.values(p.stations)) if (st.state !== "no_parts") closeInc(im, p, "no_parts", st.id, st.part);
    for (const [pid, pt] of Object.entries(p.parts)) {
      if (pt.stock <= 8) openInc(im, p, "low_stock", "warning", null, { part: pid, stock: pt.stock });
      else if (pt.stock >= 16) closeInc(im, p, "low_stock", null, pid);
      if (pt.stock >= 16) closeInc(im, p, "delivery_missed", null, pid);
    }
    while (im.defects.length && im.defects[0][0] < p.t - 3600) im.defects.shift();
    const counts = {};
    for (const [, d, sid] of im.defects) counts[d + "|" + sid] = (counts[d + "|" + sid] || 0) + 1;
    for (const [key, n] of Object.entries(counts)) {
      const [d, sid] = key.split("|");
      if (n >= 3) openInc(im, p, "quality_spike", "warning", sid, { defect: d, count: n });
    }
    for (const inc of im.items) {
      if (inc.type === "quality_spike" && inc.status !== "closed" && (counts[inc.params.defect + "|" + inc.station] || 0) < 2) { inc.status = "closed"; inc.closed_t = p.t; }
    }
    if (a) for (const [sid, x] of Object.entries(a)) {
      if (x.risk >= 0.35) openInc(im, p, "failure_risk", "warning", sid, { risk: x.risk, health: x.health, drivers: x.drivers.map((d) => d.feature) });
      else if (x.risk < 0.2) closeInc(im, p, "failure_risk", sid);
    }
    if (f) {
      if (f.p_plan < 0.5 && kpis(p).shift_elapsed > 0.1) openInc(im, p, "plan_risk", "warning", null, { p_plan: f.p_plan, expected: f.expected_shift_total, plan: f.plan });
      else if (f.p_plan >= 0.6) closeInc(im, p, "plan_risk");
    }
  }
  function incidentSnapshot(im) {
    const sev = { critical: 0, warning: 1, info: 2 };
    const active = im.items.filter((i) => i.status !== "closed").sort((a, b) => sev[a.severity] - sev[b.severity] || b.t - a.t);
    const closed = im.items.filter((i) => i.status === "closed").slice(-60).reverse();
    return active.concat(closed);
  }

  // ---------------------------------------------------------------- the twin (same surface as the REST API)
  const SPEEDS = { 1: 0.1, 60: 6, 300: 30, 900: 90 };
  class Twin {
    constructor(cfg, model, effect) { this.cfg = cfg; this.M = model; this.effect = effect; this.reset(); }
    reset() {
      this.p = createPlant(this.cfg, 7);
      this.im = createIncidents();
      this.speed = "60"; this.paused = false; this.acc = 0;
      for (const st of Object.values(this.p.stations)) if (st.state === "down" || st.state === "maintenance")
        emit(this.p, "down", st.id, { reason: st.state === "down" ? "breakdown" : "maintenance", minutes: Math.round(st.repairLeft / 60) });
      this.a = assess(this.M, this.p);
      this.f = null; this.recs = []; this.fAt = 0;
    }
    advance(realDt) {
      if (this.paused) return;
      this.acc += SPEEDS[this.speed] * realDt;
      const n = Math.floor(this.acc); this.acc -= n;
      for (let i = 0; i < n; i++) step(this.p);
      const fresh = assess(this.M, this.p);
      for (const [sid, x] of Object.entries(fresh)) {
        const prev = this.a[sid];
        if (prev && x.risk > 0) { x.risk = r(0.8 * prev.risk + 0.2 * x.risk, 3); x.level = x.risk >= 0.35 ? "high" : x.risk >= 0.18 ? "medium" : "low"; }
      }
      this.a = fresh;
      updateIncidents(this.im, this.p, this.a, this.f);
      const now = performance.now();
      if (now - this.fAt > 12000) { this.fAt = now; this.f = forecast(this.p, this.a); this.recs = recommend(this.p, this.a); }
    }
    snapshot() {
      const p = this.p, bh = p.bnHist.slice(-120), share = {};
      for (const b of bh) share[b] = (share[b] || 0) + 1;
      for (const k in share) share[k] = r(share[k] / bh.length, 3);
      const t = p.t;
      return {
        clock: { t, day: Math.floor(t / 86400) + 1, hh: Math.floor(t % 86400 / 3600), mm: Math.floor(t % 3600 / 60) },
        speed: this.speed, paused: this.paused, kpi: kpis(p),
        stations: ORDER.map((id) => {
          const st = p.stations[id];
          return { id, shop: st.shop, type: st.type, state: st.state, x: st.x, y: st.y, units: st.units.length,
            busy: st.units.filter((u) => u.car).length, buffer: st.buffer.length, buffer_cap: st.bufferCap, sensors: st.sensors,
            kpi: stationKpis(st), cycle: st.cycle, down_left_min: ["down", "maintenance"].includes(st.state) ? Math.round(st.repairLeft / 60) : 0,
            ai: this.a[id] || null };
        }),
        parts: Object.entries(p.parts).map(([k, v]) => ({ id: k, stock: v.stock, max: v.max, blocked: (p.supplyBlock[k] || 0) > p.t, next_delivery_min: Math.round((v.nextDelivery - p.t) / 60) })),
        bottleneck: { now: momentaryBottleneck(p), share: Object.fromEntries(Object.entries(share).sort((a, b) => b[1] - a[1])) },
        incidents: incidentSnapshot(this.im), forecast: this.f, recommendations: this.recs, shops: this.cfg.shops,
      };
    }
    history(minutes = 480) { return this.p.history.slice(-minutes); }
    station(sid) {
      const st = this.p.stations[sid];
      return { id: sid, sensor_hist: st.sensorHist, baseline: st.baseline, ai: this.a[sid], kpi: stationKpis(st) };
    }
    metrics() { return { model: this.M.metrics, effect: this.effect }; }
    exportCsv() {
      const h = this.p.history; if (!h.length) return "";
      const keys = Object.keys(h[0]);
      return keys.join(",") + "\n" + h.map((row) => keys.map((k) => row[k]).join(",")).join("\n");
    }
    post(path, body) {
      const p = this.p;
      if (path === "/api/speed") {
        if (body.value === "pause") this.paused = !this.paused; else { this.speed = body.value; this.paused = false; }
      } else if (path.startsWith("/api/scenario/")) {
        const name = path.split("/").pop();
        if (name === "reset") this.reset();
        else if (name === "robot_failure") forceFailure(p, "W3", 90);
        else if (name === "supply_delay") { blockSupply(p, "engine", 4); p.parts.engine.stock = Math.min(p.parts.engine.stock, 10); }
        else if (name === "paint_quality") { p.stations.P2.defectMult = 6; p.stations.P2.defectUntil = p.t + 7200; }
        else if (name === "wear") { p.stations.A2.health = 0.3; p.stations.A2.sinceMaint = 1.1 * p.stations.A2.mtbf; }
        this.fAt = 0;
      } else if (path.startsWith("/api/maintenance/")) {
        const ok = scheduleMaintenance(p, path.split("/").pop()); this.fAt = 0; return { ok };
      } else if (path.startsWith("/api/incidents/")) {
        const id = +path.split("/")[3], inc = this.im.items.find((i) => i.id === id && i.status === "open");
        if (inc) inc.status = "ack";
      }
      return { ok: true };
    }
  }

  window.LocalTwin = Twin;
})();
