/* ALLUR Digital Twin — dashboard client. Vanilla JS + Chart.js, data over WebSocket. */
(() => {
  const FLOW = ["W1", "W2", "W3", "W4", "P1", "P2", "P3", "A1", "A2", "A3", "Q1", "Q2", "Q3", "L1"];
  const STATES = ["working", "starved", "blocked", "down", "maintenance", "no_parts"];
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const COLORS = Object.fromEntries(STATES.map((s) => [s, css("--" + s)]));
  const RISK = { low: css("--risk-low"), medium: css("--risk-medium"), high: css("--risk-high") };

  let lang = localStorageGet("lang") || "ru";
  let S = null;              // latest snapshot
  let history = [];
  let metrics = null;
  let selected = null;
  const charts = {};

  function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

  // ------------------------------------------------------------------ i18n
  function t(key, params) {
    let s = (I18N[lang] && I18N[lang][key]) ?? I18N.ru[key] ?? key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll("{" + k + "}", v);
    return s;
  }
  const stName = (id) => id ? `${id} ${t("st_" + id)}` : "";
  const fmtTime = (sec) => {
    const d = Math.floor(sec / 86400) + 1, h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    return `${t("day")} ${d}, ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };
  const pct = (x, d = 0) => (x * 100).toFixed(d) + "%";
  const num = (x) => Number(x).toLocaleString(lang === "ko" ? "ko-KR" : "ru-RU");

  function applyLang() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll(".lang button").forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));
    document.getElementById("legend").innerHTML = STATES.map((s) => `<span><i style="background:${COLORS[s]}"></i>${t("s_" + s)}</span>`).join("");
    buildMap();
    Object.values(charts).forEach((c) => c.destroy());
    for (const k in charts) delete charts[k];
    if (S) render();
    renderMetrics();
  }

  // ------------------------------------------------------------------ connection
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    const dot = document.getElementById("conn");
    ws.onopen = () => { dot.classList.add("on"); dot.title = t("live"); };
    ws.onclose = () => { dot.classList.remove("on"); dot.title = t("offline"); setTimeout(connect, 1500); poll(); };
    ws.onmessage = (e) => { S = JSON.parse(e.data); render(); };
  }
  // fallback when WebSockets are blocked (corporate proxies): poll the REST snapshot
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    while (!document.getElementById("conn").classList.contains("on")) {
      try { S = await (await fetch("/api/state")).json(); render(); } catch { /* server down */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    polling = false;
  }
  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }
  async function refreshHistory() {
    try { history = await (await fetch("/api/history?minutes=480")).json(); } catch { /* retry later */ }
  }
  async function loadMetrics() {
    try { metrics = await (await fetch("/api/metrics")).json(); renderMetrics(); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ KPIs
  function renderKpis() {
    const k = S.kpi;
    const attain = k.attainment;
    const cls = (v, g, w) => (v >= g ? "good" : v >= w ? "warn" : "bad");
    const tiles = [
      { label: t("k_produced"), value: `${k.produced}<small> / ${k.plan} ${t("k_plan")}</small>`, bar: k.produced / k.plan },
      { label: t("k_attain"), value: attain == null ? "—" : pct(attain), cls: attain == null ? "" : cls(attain, 1, 0.92) },
      { label: t("k_jph"), value: k.jph },
      { label: t("k_oee"), value: pct(k.oee), cls: cls(k.oee, 0.85, 0.7) },
      { label: t("k_fpy"), value: pct(k.fpy, 1), cls: cls(k.fpy, 0.9, 0.8) },
      { label: t("k_downtime"), value: Math.round(k.downtime_min), cls: k.downtime_min > 60 ? "bad" : k.downtime_min > 20 ? "warn" : "good" },
      { label: t("k_wip"), value: `${k.wip}<small> · ${k.rework_queue} ${t("k_rework")}</small>` },
    ];
    document.getElementById("kpis").innerHTML = tiles.map((x) =>
      `<div class="kpi ${x.cls || ""}"><div class="label">${x.label}</div><div class="value">${x.value}</div>${x.bar !== undefined ? `<div class="bar"><i style="width:${Math.min(100, x.bar * 100)}%"></i></div>` : ""}</div>`).join("");
    const c = S.clock;
    document.getElementById("clock").textContent = `${String(c.hh).padStart(2, "0")}:${String(c.mm).padStart(2, "0")}`;
    document.getElementById("clock-sub").textContent = `${t("day")} ${c.day} · ${t("shift")} ${k.shift}`;
    document.getElementById("speed").value = S.speed;
    document.getElementById("pause").classList.toggle("primary", S.paused);
  }

  // ------------------------------------------------------------------ map
  const SW = 64, SH = 56;
  function buildMap() {
    const svg = document.getElementById("map");
    if (!S) { svg.innerHTML = ""; return; }
    const st = Object.fromEntries(S.stations.map((s) => [s.id, s]));
    let h = "";
    for (const sh of S.shops) {
      h += `<g class="shop"><rect x="${sh.x}" y="${sh.y}" width="${sh.w}" height="${sh.h}" rx="14"/><text x="${sh.x + 12}" y="${sh.y + 22}">${t("shop_" + sh.id)}</text></g>`;
    }
    // flow arrows
    const path = [];
    for (let i = 0; i < FLOW.length - 1; i++) {
      const a = st[FLOW[i]], b = st[FLOW[i + 1]];
      let d;
      if (a.id === "A3") d = `M${a.x} ${a.y + SH / 2} L${b.x} ${b.y - SH / 2}`;
      else if (a.id === "Q3") d = `M${a.x - SW / 2} ${a.y} L${b.x + SW / 2 + 6} ${b.y}`;
      else if (a.y === b.y) d = `M${a.x + (a.x < b.x ? SW / 2 : -SW / 2)} ${a.y} L${b.x + (a.x < b.x ? -SW / 2 : SW / 2)} ${b.y}`;
      else d = `M${a.x} ${a.y} L${b.x} ${b.y}`;
      path.push(`<path class="flow" data-from="${a.id}" d="${d}" marker-end="url(#arr)"/>`);
    }
    const q3 = st.Q3, rw = st.RW;
    path.push(`<path class="flow" data-from="Q3" d="M${q3.x - 12} ${q3.y + SH / 2} L${rw.x - 12} ${rw.y - SH / 2}" marker-end="url(#arr)"/>`);
    path.push(`<path class="flow" data-from="RW" d="M${rw.x + 12} ${rw.y - SH / 2} L${q3.x + 12} ${q3.y + SH / 2}" marker-end="url(#arr)"/>`);
    h = `<defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#3b5587"/></marker></defs>` + h + path.join("");
    // warehouse block
    h += `<g id="stock-svg" class="stock-svg"></g>`;
    for (const s of S.stations) {
      h += `<g class="station" data-id="${s.id}" transform="translate(${s.x - SW / 2},${s.y - SH / 2})">
        <rect class="body" width="${SW}" height="${SH}" rx="9"/>
        <rect class="bn hidden" x="-5" y="-5" width="${SW + 10}" height="${SH + 10}" rx="12"/>
        <text x="${SW / 2}" y="24">${s.id}</text>
        <text class="sub" x="${SW / 2}" y="42" style="font-size:10px;font-weight:600"></text>
        <g class="buf" transform="translate(0,${SH + 5})"></g>
        <g class="risk-dot hidden" transform="translate(${SW - 2},2)"><circle r="11"/><text y="3"></text></g>
      </g>`;
    }
    svg.innerHTML = h;
    svg.querySelectorAll(".station").forEach((g) => g.addEventListener("click", () => openStation(g.dataset.id)));
  }

  function renderMap() {
    const svg = document.getElementById("map");
    if (!svg.querySelector(".station")) buildMap();
    for (const s of S.stations) {
      const g = svg.querySelector(`.station[data-id="${s.id}"]`);
      if (!g) continue;
      g.classList.toggle("down", s.state === "down");
      const body = g.querySelector("rect.body");
      body.setAttribute("fill", COLORS[s.state]);
      body.setAttribute("stroke", selected === s.id ? "#fff" : "rgba(0,0,0,.25)");
      g.querySelector("text.sub").textContent = s.state === "down" || s.state === "maintenance" ? `${s.down_left_min} ${t("minutes")}` : `${s.busy}/${s.units}`;
      g.querySelector(".bn").classList.toggle("hidden", S.bottleneck.now !== s.id);
      // input buffer cells
      const cells = Math.min(s.buffer_cap, 10), w = SW / cells;
      g.querySelector(".buf").innerHTML = Array.from({ length: cells }, (_, i) =>
        `<rect x="${i * w + 1}" width="${w - 2}" height="5" rx="1" class="${i < s.buffer ? "f" : ""}"/>`).join("");
      const rd = g.querySelector(".risk-dot");
      if (s.ai && s.ai.level !== "low") {
        rd.classList.remove("hidden");
        rd.querySelector("circle").setAttribute("fill", RISK[s.ai.level]);
        rd.querySelector("text").textContent = Math.round(s.ai.risk * 100);
      } else rd.classList.add("hidden");
      const title = `${stName(s.id)} — ${t("s_" + s.state)}`;
      let tt = g.querySelector("title");
      if (!tt) { tt = document.createElementNS("http://www.w3.org/2000/svg", "title"); g.appendChild(tt); }
      tt.textContent = title;
    }
    svg.querySelectorAll(".flow").forEach((p) => {
      const s = S.stations.find((x) => x.id === p.dataset.from);
      p.classList.toggle("run", s && s.state === "working");
    });
    // stock bars inside the logistics shop
    const shop = S.shops.find((x) => x.id === "logistics");
    let h = `<text x="${shop.x + 14}" y="${shop.y + 50}" style="font-weight:600">${t("stock_title")}</text>`;
    S.parts.forEach((p, i) => {
      const y = shop.y + 66 + i * 28, w = 160, f = p.stock / p.max;
      const col = p.stock <= 8 ? COLORS.down : f < 0.35 ? COLORS.blocked : COLORS.working;
      h += `<text x="${shop.x + 14}" y="${y + 10}">${t("p_" + p.id)}</text>
            <rect x="${shop.x + 150}" y="${y}" width="${w}" height="12" rx="3" fill="#24365a"/>
            <rect x="${shop.x + 150}" y="${y}" width="${w * f}" height="12" rx="3" fill="${col}"/>
            <text x="${shop.x + 318}" y="${y + 10}">${p.stock}${p.blocked ? " ⚠" : ""}</text>`;
    });
    svg.querySelector("#stock-svg").innerHTML = h;
    document.getElementById("bn-now").textContent = stName(S.bottleneck.now);
  }

  // ------------------------------------------------------------------ incidents
  function incText(i) {
    const p = Object.assign({}, i.params);
    if (p.part) p.part = t("p_" + p.part);
    if (p.defect) p.defect = t("d_" + p.defect);
    if (p.risk !== undefined) p.risk = Math.round(p.risk * 100);
    if (p.health !== undefined) p.health = Math.round(p.health * 100);
    if (p.expected !== undefined) p.expected = Math.round(p.expected);
    return t("i_" + i.type, Object.assign(p, { st: stName(i.station) }));
  }
  function renderFeed() {
    const items = S.incidents.slice(0, 25);
    const active = S.incidents.filter((i) => i.status === "open");
    const badge = document.getElementById("inc-badge");
    badge.textContent = active.length;
    badge.classList.toggle("hidden", !active.length);
    document.getElementById("feed").innerHTML = items.length ? items.map((i) =>
      `<li class="${i.severity} ${i.status}"><div class="meta"><span>${fmtTime(i.t)} · ${t("sev_" + i.severity)}</span><span>${t("stat_" + i.status)}</span></div>${incText(i)}</li>`).join("")
      : `<li class="info">${t("no_incidents")}</li>`;
    const only = document.getElementById("only-active").checked;
    const rows = S.incidents.filter((i) => !only || i.status !== "closed");
    document.querySelector("#inc-table tbody").innerHTML = rows.map((i) => `<tr>
      <td>${fmtTime(i.t)}</td>
      <td><span class="pill" style="background:${i.severity === "critical" ? COLORS.down : i.severity === "warning" ? COLORS.blocked : css("--accent")}">${t("sev_" + i.severity)}</span></td>
      <td>${incText(i)}</td><td>${t("stat_" + i.status)}${i.closed_t ? ` · ${fmtTime(i.closed_t)}` : ""}</td>
      <td>${i.status === "open" ? `<button class="btn" data-ack="${i.id}">${t("ack")}</button>` : ""}</td></tr>`).join("");
  }

  // ------------------------------------------------------------------ forecast & recommendations
  function forecastHtml(full) {
    const f = S.forecast;
    if (!f) return `<p class="muted">${t("calculating")}</p>`;
    const col = f.p_plan >= 0.7 ? COLORS.working : f.p_plan >= 0.4 ? COLORS.blocked : COLORS.down;
    const bn = Object.entries(f.bottleneck_share)[0];
    let h = `<div class="row"><span>${t("forecast_expected")}</span><b class="big">${Math.round(f.expected_shift_total)}<small class="muted" style="font-size:14px"> / ${f.plan}</small></b></div>
      <div class="row"><span>${t("forecast_range")}</span><b>${S.kpi.produced + f.p10} – ${S.kpi.produced + f.p90}</b></div>
      <div class="row"><span>${t("p_plan")}</span><b style="color:${col}">${pct(f.p_plan)}</b></div>
      <div class="prob"><i style="width:${f.p_plan * 100}%;background:${col}"></i></div>
      <div class="row"><span>${t("predicted_bn")}</span><b>${bn ? stName(bn[0]) : "—"}</b></div>`;
    if (full) {
      const dt = Object.entries(f.expected_downtime);
      h += `<div class="section"><div class="muted small" style="margin:8px 0 4px">${t("expected_downtime")}</div>` +
        (dt.length ? dt.map(([k, v]) => `<div class="row"><span>${stName(k)}</span><b>${Math.round(v)} ${t("minutes")}</b></div>`).join("") : "—") + `</div>`;
    }
    return h;
  }
  function recsHtml() {
    const r = S.recommendations || [];
    if (!r.length) return `<p class="muted">${S.forecast ? t("no_recs") : t("calculating")}</p>`;
    return r.map((x) => `<div class="rec"><div>${t("rec_line", { st: stName(x.station), verdict: t("rec_" + x.verdict), gain: (x.gain_cars >= 0 ? "+" : "") + x.gain_cars, saved: Math.max(0, Math.round(x.downtime_saved_min)) })}
      <div class="muted small">${t("risk2h")}: ${pct(x.risk)}</div></div>
      ${x.verdict !== "monitor" ? `<button class="btn primary" data-pm="${x.station}">${t("apply")}</button>` : ""}</div>`).join("");
  }

  // ------------------------------------------------------------------ charts
  function chart(id, cfg) {
    const base = {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { labels: { color: css("--muted"), boxWidth: 12 } } },
      scales: {},
    };
    cfg.options = Object.assign(base, cfg.options || {});
    for (const ax of Object.values(cfg.options.scales)) {
      ax.ticks = Object.assign({ color: css("--muted") }, ax.ticks || {});
      ax.grid = Object.assign({ color: "#1c2a47" }, ax.grid || {});
    }
    if (!charts[id]) charts[id] = new Chart(document.getElementById(id), cfg);
    else { charts[id].data = cfg.data; charts[id].update("none"); }
  }
  const hhmm = (sec) => `${String(Math.floor(sec % 86400 / 3600)).padStart(2, "0")}:${String(Math.floor(sec % 3600 / 60)).padStart(2, "0")}`;

  function renderExec() {
    const shiftStart = S.clock.t - S.kpi.shift_elapsed * 8 * 3600;
    const hs = history.filter((x) => x.t > shiftStart);
    chart("c-output", {
      type: "line",
      data: { labels: hs.map((x) => hhmm(x.t)), datasets: [
        { label: t("produced"), data: hs.map((x) => x.produced), borderColor: css("--accent"), backgroundColor: "rgba(63,167,255,.15)", fill: true, pointRadius: 0, tension: .2 },
        { label: t("plan_line"), data: hs.map((x) => x.plan_to_date), borderColor: "#94a3b8", borderDash: [6, 4], pointRadius: 0 },
      ] },
      options: { scales: { x: { ticks: { maxTicksLimit: 9 } }, y: { beginAtZero: true } } },
    });
    const h8 = history.slice(-480);
    chart("c-jph", {
      type: "line",
      data: { labels: h8.map((x) => hhmm(x.t)), datasets: [
        { label: t("k_jph"), data: h8.map((x) => x.jph), borderColor: css("--accent2"), pointRadius: 0, yAxisID: "y" },
        { label: "OEE %", data: h8.map((x) => Math.round(x.oee * 100)), borderColor: css("--maintenance"), pointRadius: 0, yAxisID: "y1" },
      ] },
      options: { scales: { x: { ticks: { maxTicksLimit: 6 } }, y: { beginAtZero: true }, y1: { position: "right", min: 0, max: 100, grid: { display: false } } } },
    });
    const main = S.stations.filter((s) => s.id !== "L1");
    chart("c-oee", {
      type: "bar",
      data: { labels: main.map((s) => s.id), datasets: [{ label: "OEE", data: main.map((s) => Math.round(s.kpi.oee * 100)),
        backgroundColor: main.map((s) => s.kpi.oee >= 0.8 ? COLORS.working : s.kpi.oee >= 0.6 ? COLORS.blocked : COLORS.down) }] },
      options: { plugins: { legend: { display: false } }, scales: { x: {}, y: { min: 0, max: 100 } } },
    });
    chart("c-losses", {
      type: "bar",
      data: { labels: main.map((s) => s.id), datasets: ["down", "maintenance", "no_parts", "blocked", "starved"].map((k) => ({
        label: t("s_" + k), data: main.map((s) => Math.round(s.kpi.time[k])), backgroundColor: COLORS[k], stack: "a" })) },
      options: { scales: { x: { stacked: true }, y: { stacked: true } } },
    });
    const share = Object.entries(S.bottleneck.share);
    chart("c-bn", {
      type: "doughnut",
      data: { labels: share.map(([k]) => stName(k)), datasets: [{ data: share.map(([, v]) => Math.round(v * 100)),
        backgroundColor: ["#ef4444", "#f59e0b", "#3fa7ff", "#a78bfa", "#22d3a6", "#64748b", "#fb923c"], borderWidth: 0 }] },
      options: { plugins: { legend: { position: "right", labels: { color: css("--muted"), boxWidth: 10 } } } },
    });
    const defs = Object.entries(S.kpi.defects).sort((a, b) => b[1] - a[1]);
    chart("c-defects", {
      type: "bar",
      data: { labels: defs.map(([k]) => t("d_" + k)), datasets: [{ label: t("defects_pareto"), data: defs.map(([, v]) => v), backgroundColor: COLORS.blocked }] },
      options: { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: {} } },
    });
    document.getElementById("forecast-full").innerHTML = forecastHtml(true);
    document.getElementById("recs").innerHTML = recsHtml();
    document.getElementById("stock").innerHTML = S.parts.map((p) => {
      const f = p.stock / p.max, col = p.stock <= 8 ? COLORS.down : f < 0.35 ? COLORS.blocked : COLORS.working;
      return `<div class="stock-row"><span>${t("p_" + p.id)}</span><span class="meter"><i style="width:${f * 100}%;background:${col}"></i></span>
        <span>${p.stock} / ${p.max} · <span class="${p.blocked ? "" : "muted"}" style="${p.blocked ? "color:" + COLORS.down : ""}">${p.blocked ? t("delivery_blocked") : t("next_delivery", { m: p.next_delivery_min })}</span></span></div>`;
    }).join("");
  }

  // ------------------------------------------------------------------ AI tab
  function renderAi() {
    const rows = S.stations.filter((s) => s.ai).sort((a, b) => b.ai.risk - a.ai.risk);
    document.querySelector("#risk-table tbody").innerHTML = rows.map((s) => {
      const hc = s.ai.health >= 0.7 ? COLORS.working : s.ai.health >= 0.45 ? COLORS.blocked : COLORS.down;
      return `<tr><td><b>${s.id}</b> ${t("st_" + s.id)}</td>
        <td><span class="pill" style="background:${COLORS[s.state]}">${t("s_" + s.state)}</span></td>
        <td><span class="meter"><i style="width:${s.ai.health * 100}%;background:${hc}"></i></span>${pct(s.ai.health)}</td>
        <td><span class="meter"><i style="width:${Math.min(100, s.ai.risk * 200)}%;background:${RISK[s.ai.level]}"></i></span>${pct(s.ai.risk)}</td>
        <td class="small">${s.ai.drivers.map((d) => t(d.feature)).join(", ")}</td>
        <td>${s.state === "down" || s.state === "maintenance" ? "" : `<button class="btn" data-pm="${s.id}">${t("schedule_pm_short")}</button>`}</td></tr>`;
    }).join("");
  }

  function renderMetrics() {
    if (!metrics) return;
    const m = metrics.model || {};
    document.getElementById("model-metrics").innerHTML = `
      <div class="row"><span>${t("m_auc")}</span><b>${m.roc_auc ?? "—"}</b></div>
      <div class="row"><span>${t("m_lift")}</span><b>×${m.lift_top10 ?? "—"}</b></div>
      <div class="row"><span>${t("m_recall")}</span><b>${m.recall_top10 !== undefined ? pct(m.recall_top10) : "—"}</b></div>
      <div class="row"><span>${t("m_samples")}</span><b>${m.samples ? num(m.samples) : "—"}</b></div>`;
    const e = metrics.effect;
    if (!e) return;
    document.getElementById("effect-desc").textContent = t("effect_desc", { days: e.days_per_seed, seeds: e.seeds });
    const d = e.days_per_seed;
    const r = e.reactive, p = e.predictive;
    if (charts["c-effect"]) { charts["c-effect"].destroy(); delete charts["c-effect"]; }
    chart("c-effect", {
      type: "bar",
      data: { labels: [t("e_breakdown"), t("e_output"), t("e_plan")], datasets: [
        { label: t("reactive"), data: [r.breakdown_min / d, r.cars / d, r.plan_hit * 100].map((x) => Math.round(x)), backgroundColor: "#64748b" },
        { label: t("predictive"), data: [p.breakdown_min / d, p.cars / d, p.plan_hit * 100].map((x) => Math.round(x)), backgroundColor: css("--accent2") },
      ] },
      options: { scales: { x: {}, y: { beginAtZero: true } } },
    });
    renderCalc();
  }

  const calcState = { days: 250, shifts: 2, margin: 700000, downcost: 1500000 };
  function renderCalc() {
    const e = metrics && metrics.effect;
    if (!e) return;
    const box = document.getElementById("calc");
    if (!box.querySelector("input")) {
      box.className = "calc";
      box.innerHTML = [["days", "calc_days"], ["shifts", "calc_shifts"], ["margin", "calc_margin"], ["downcost", "calc_downcost"]]
        .map(([k, l]) => `<label><span>${t(l)}</span><input type="number" data-calc="${k}" value="${calcState[k]}"></label>`).join("") + `<div class="out" id="calc-out"></div>`;
      box.querySelectorAll("input").forEach((i) => i.addEventListener("input", () => { calcState[i.dataset.calc] = +i.value || 0; renderCalc(); }));
    }
    const d = e.days_per_seed, perShift = (x) => x / d / 3;
    const extraCars = (perShift(e.predictive.cars) - perShift(e.reactive.cars)) * calcState.shifts * calcState.days;
    const hours = (perShift(e.reactive.breakdown_min) - perShift(e.predictive.breakdown_min)) * calcState.shifts * calcState.days / 60;
    // downtime cost is counted only for the part of downtime not already reflected in extra output (half, conservative)
    const money = extraCars * calcState.margin + hours * 0.5 * calcState.downcost;
    document.getElementById("calc-out").innerHTML = `
      <div class="row"><span>${t("calc_extra")}</span><b>+${num(Math.round(extraCars))} ${t("cars")}</b></div>
      <div class="row"><span>${t("calc_hours")}</span><b>−${num(Math.round(hours))}</b></div>
      <div class="row"><span>${t("calc_money")}</span><b class="big" style="font-size:22px">${num(Math.round(money / 1e6))} ${t("calc_mln")}</b></div>
      <p class="muted small">${t("calc_note")}</p>`;
  }

  // ------------------------------------------------------------------ station drawer
  async function openStation(id) {
    selected = id;
    document.getElementById("drawer").classList.add("open");
    await renderDrawer();
  }
  async function renderDrawer() {
    if (!selected || !S) return;
    const s = S.stations.find((x) => x.id === selected);
    let det;
    try { det = await (await fetch("/api/station/" + selected)).json(); } catch { return; }
    const k = s.kpi, ai = s.ai;
    const body = document.getElementById("drawer-body");
    body.innerHTML = `
      <h2>${stName(s.id)}</h2>
      <div class="muted">${t("shop_" + s.shop)}</div>
      <div class="section"><span class="pill" style="background:${COLORS[s.state]}">${t("s_" + s.state)}</span>
        ${s.state === "starved" ? `<span class="muted small"> ${t("s_hint_starved")}</span>` : s.state === "blocked" ? `<span class="muted small"> ${t("s_hint_blocked")}</span>` : ""}
        ${s.down_left_min ? `<span class="small"> · ${s.down_left_min} ${t("minutes")}</span>` : ""}</div>
      ${ai ? `<div class="section">
        <div class="row"><span>${t("health")}</span><b>${pct(ai.health)}</b></div>
        <div class="row"><span>${t("risk2h")}</span><b style="color:${RISK[ai.level]}">${pct(ai.risk)}</b></div>
        <div class="row"><span>${t("drivers")}</span><b>${ai.drivers.map((d) => t(d.feature)).join(", ")}</b></div>
        <button class="btn primary" style="margin-top:8px" data-pm="${s.id}" ${s.state === "down" || s.state === "maintenance" ? "disabled" : ""}>${t("schedule_pm")}</button>
      </div>` : ""}
      <div class="section"><div class="muted small">${t("sensor_chart")}</div><div class="chart"><canvas id="c-sensor"></canvas></div></div>
      <div class="section">
        <div class="row"><span>OEE</span><b>${pct(k.oee)}</b></div>
        <div class="row"><span>${t("availability")}</span><b>${pct(k.availability)}</b></div>
        <div class="row"><span>${t("performance")}</span><b>${pct(k.performance)}</b></div>
        <div class="row"><span>${t("quality")}</span><b>${pct(k.quality, 1)}</b></div>
        <div class="row"><span>${t("utilization")}</span><b>${pct(k.utilization)}</b></div>
        <div class="row"><span>${t("cycle")}</span><b>${s.cycle}${s.units > 1 ? " × " + s.units : ""}</b></div>
        <div class="row"><span>${t("buffer")}</span><b>${s.buffer} / ${s.buffer_cap}</b></div>
        <div class="row"><span>${t("failures")}</span><b>${k.failures}</b></div>
      </div>
      <div class="section"><div class="muted small">${t("sensors")}</div>
        <div class="row"><span>${t("vibration")}</span><b>${s.sensors.vibration} mm/s</b></div>
        <div class="row"><span>${t("temperature")}</span><b>${s.sensors.temperature} °C</b></div>
        <div class="row"><span>${t("current")}</span><b>${s.sensors.current} A</b></div>
      </div>`;
    const b = det.baseline, hs = det.sensor_hist;
    if (charts["c-sensor"]) { charts["c-sensor"].destroy(); delete charts["c-sensor"]; }
    chart("c-sensor", {
      type: "line",
      data: { labels: hs.map((_, i) => i - hs.length + 1), datasets: [
        { label: t("vibration"), data: hs.map((x) => +(x[0] / b.vibration).toFixed(2)), borderColor: COLORS.down, pointRadius: 0 },
        { label: t("temperature"), data: hs.map((x) => +(x[1] / b.temperature).toFixed(3)), borderColor: COLORS.blocked, pointRadius: 0 },
        { label: t("current"), data: hs.map((x) => +(x[2] / b.current).toFixed(2)), borderColor: css("--accent"), pointRadius: 0 },
      ] },
      options: { scales: { x: { ticks: { maxTicksLimit: 6 } }, y: {} } },
    });
  }

  // ------------------------------------------------------------------ main render
  let lastHist = 0, lastDrawer = 0;
  function render() {
    renderKpis();
    renderMap();
    renderFeed();
    document.getElementById("forecast-mini").innerHTML = forecastHtml(false);
    const tab = document.querySelector(".tab.active").dataset.tab;
    const now = Date.now();
    if (now - lastHist > 4000) { lastHist = now; refreshHistory(); }
    if (tab === "exec") renderExec();
    if (tab === "ai") renderAi();
    if (selected && now - lastDrawer > 3000) { lastDrawer = now; renderDrawer(); }
  }

  // ------------------------------------------------------------------ events
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + b.dataset.tab));
    if (b.dataset.tab === "ai") renderMetrics();
    if (S) render();
  }));
  document.querySelectorAll(".lang button").forEach((b) => b.addEventListener("click", () => {
    lang = b.dataset.lang; localStorageSet("lang", lang); applyLang();
    const calc = document.getElementById("calc"); calc.innerHTML = ""; renderCalc();
  }));
  document.getElementById("speed").addEventListener("change", (e) => post("/api/speed", { value: e.target.value }));
  document.getElementById("pause").addEventListener("click", () => post("/api/speed", { value: "pause" }));
  document.querySelectorAll(".sc").forEach((b) => b.addEventListener("click", async () => {
    await post("/api/scenario/" + b.dataset.sc);
    if (b.dataset.sc === "reset") { history = []; selected = null; document.getElementById("drawer").classList.remove("open"); }
  }));
  document.getElementById("drawer-close").addEventListener("click", () => { selected = null; document.getElementById("drawer").classList.remove("open"); });
  document.getElementById("only-active").addEventListener("change", () => S && renderFeed());
  document.body.addEventListener("click", async (e) => {
    const pm = e.target.closest("[data-pm]");
    if (pm) { pm.disabled = true; pm.textContent = t("pm_done"); await post("/api/maintenance/" + pm.dataset.pm); }
    const ack = e.target.closest("[data-ack]");
    if (ack) { await post(`/api/incidents/${ack.dataset.ack}/ack`); }
  });

  applyLang();
  connect();
  loadMetrics();
})();
