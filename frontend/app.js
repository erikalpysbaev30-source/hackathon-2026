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
  const equipOf = (id) => (S && (S.stations.find((x) => x.id === id) || {}).equip) || "";
  const stFull = (id) => { const e = equipOf(id); return stName(id) + (e ? ` (${e})` : ""); };
  // plant time counts working hours only (2 shifts from 08:00): map it to day and wall-clock time
  const cal = (sec) => {
    const wd = ((S && S.kpi.shifts_per_day) || 3) * 8 * 3600, rel = sec - 8 * 3600;
    const wall = 8 * 3600 + (((rel % wd) + wd) % wd);
    return { day: Math.floor(rel / wd) + 1, hh: Math.floor(wall % 86400 / 3600), mm: Math.floor(wall % 3600 / 60) };
  };
  const fmtTime = (sec) => {
    const c = cal(sec);
    return `${t("day")} ${c.day}, ${String(c.hh).padStart(2, "0")}:${String(c.mm).padStart(2, "0")}`;
  };
  const pct = (x, d = 0) => (x * 100).toFixed(d) + "%";
  const pctL = (x, d = 1) => (x * 100).toLocaleString(lang === "ko" ? "ko-KR" : "ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d }) + "%";
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
    if (document.querySelector(".tab.active").dataset.tab === "data") renderData();
  }

  // ------------------------------------------------------------------ connection
  // Static mode: the whole twin runs in the browser (engine.js), no server needed.
  const LOCAL = window.LOCAL_DATA && window.LocalTwin ? new LocalTwin(LOCAL_DATA.config, LOCAL_DATA.model, LOCAL_DATA.effect) : null;
  function connectLocal() {
    const dot = document.getElementById("conn");
    dot.classList.add("on"); dot.title = t("live");
    let last = performance.now(), lastRender = 0;
    setInterval(() => {
      const now = performance.now();
      LOCAL.advance((now - last) / 1000); last = now;
      if (now - lastRender > 950) { lastRender = now; S = LOCAL.snapshot(); render(); }
    }, 200);
    S = LOCAL.snapshot(); render();
  }
  function connect() {
    if (LOCAL) return connectLocal();
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
    if (LOCAL) { const res = LOCAL.post(url, body); S = LOCAL.snapshot(); render(); return res; }
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }
  async function refreshHistory() {
    if (LOCAL) { history = LOCAL.history(480); return; }
    try { history = await (await fetch("/api/history?minutes=480")).json(); } catch { /* retry later */ }
  }
  async function loadMetrics() {
    if (LOCAL) { metrics = LOCAL.metrics(); renderMetrics(); return; }
    try { metrics = await (await fetch("/api/metrics")).json(); renderMetrics(); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ KPIs
  function renderKpis() {
    const k = S.kpi;
    const attain = k.attainment;
    const cls = (v, g, w) => (v >= g ? "good" : v >= w ? "warn" : "bad");
    const tg = k.targets || {}, oeeT = tg.oee || 0.85, defT = tg.defect_rate || 0.02, dayT = tg.downtime_min_day || 60;
    const dr = k.defect_rate_by_shop || {};
    const drHtml = ["welding", "paint", "assembly"].map((sh) =>
      `<span style="color:${(dr[sh] || 0) > defT ? COLORS.down : COLORS.working}">${pctL(dr[sh] || 0)}</span>`).join("<small> · </small>");
    const worst = S.stations.filter((s) => s.id !== "L1" && s.id !== "RW").reduce((a, s) => (!a || s.down_day_min > a.down_day_min ? s : a), null);
    const tiles = [
      { label: t("k_produced"), value: `${k.produced}<small> / ${k.plan} ${t("k_plan")}</small>`, bar: k.produced / k.plan },
      { label: t("k_attain"), value: attain == null ? "—" : pct(attain), cls: attain == null ? "" : cls(attain, 1, 0.92) },
      { label: t("k_jph"), value: k.jph },
      { label: `${t("k_oee")} · ${t("target")} ≥ ${pct(oeeT)}`, value: pct(k.oee), cls: cls(k.oee, oeeT, oeeT - 0.1) },
      { label: `${t("k_defect_shop")} · ≤ ${pct(defT)}`, value: `<span style="font-size:13px;white-space:nowrap">${drHtml}</span>`, title: t("k_defect_shop_hint") },
      { label: t("k_fpy"), value: pct(k.fpy, 1), cls: cls(k.fpy, 0.9, 0.8) },
      { label: `${t("k_day_down")} · ≤ ${dayT} ${t("minutes")}`, value: worst ? `${worst.down_day_min}<small> ${t("minutes")} · ${worst.id}</small>` : "—",
        cls: !worst ? "" : worst.down_day_min > dayT ? "bad" : worst.down_day_min >= 0.75 * dayT ? "warn" : "good" },
      { label: t("k_downtime"), value: Math.round(k.downtime_min), cls: k.downtime_min > 60 ? "bad" : k.downtime_min > 20 ? "warn" : "good" },
      { label: t("k_wip"), value: `${k.wip}<small> · ${k.rework_queue} ${t("k_rework")}</small>` },
    ];
    document.getElementById("kpis").innerHTML = tiles.map((x) =>
      `<div class="kpi ${x.cls || ""}"${x.title ? ` title="${x.title}"` : ""}><div class="label">${x.label}</div><div class="value">${x.value}</div>${x.bar !== undefined ? `<div class="bar"><i style="width:${Math.min(100, x.bar * 100)}%"></i></div>` : ""}</div>`).join("");
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
    const cause = p.cause ? ` (${t("c_" + p.cause)})` : "";
    p.cause = cause;
    return t("i_" + i.type, Object.assign(p, { st: stFull(i.station) }));
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
    if (!window.Chart) return; // chart library unavailable: the rest of the dashboard still works
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
  const hhmm = (sec) => { const c = cal(sec); return `${String(c.hh).padStart(2, "0")}:${String(c.mm).padStart(2, "0")}`; };

  function renderExec() {
    const shiftStart = S.clock.t - S.kpi.shift_elapsed * 8 * 3600;
    const oeeT = (S.kpi.targets || {}).oee || 0.85;
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
        backgroundColor: main.map((s) => s.kpi.oee >= oeeT ? COLORS.working : s.kpi.oee >= oeeT - 0.2 ? COLORS.blocked : COLORS.down) }] },
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
      return `<tr><td><b>${s.id}</b> ${t("st_" + s.id)}${s.equip ? `<div class="muted small">${s.equip}</div>` : ""}</td>
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
    const d = e.days_per_seed, perShift = (x) => x / d / (e.shifts_per_day || 2);
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

  // ------------------------------------------------------------------ organizer data tab
  // Same rules as backend/app/testdata.py: OEE = (run h / shift h) x min(1, fact / (plan/h x run h)) x (1 - defects / released).
  let DATA = window.ALLUR_DATA ? JSON.parse(JSON.stringify(window.ALLUR_DATA)) : null;
  let dataFiles = null;
  const dtr = (x) => { if (lang !== "ko" || x == null) return x; let s = String(x); for (const [a, b] of window.DATA_KO || []) s = s.split(a).join(b); return s; };
  const areaOf = (line) => String(line).split("-")[0].trim();
  const n1 = (x) => Number(x).toLocaleString(lang === "ko" ? "ko-KR" : "ru-RU", { maximumFractionDigits: 1 });

  function analyze(d) {
    const tg = d.targets, sh = tg.shift_hours;
    const q = {};
    for (const r of d.quality) q[r.date + "|" + r.area] = r;
    const down = {};
    for (const r of d.downtime) { const k = r.date + "|" + r.equip; down[k] = down[k] || { date: r.date, equip: r.equip, area: r.area, minutes: 0, causes: [] }; down[k].minutes += r.minutes; down[k].causes.push(r.cause); }
    const logged = {};
    for (const r of d.downtime) logged[r.date + "|" + r.area] = (logged[r.date + "|" + r.area] || 0) + r.minutes;
    const lines = d.lines.map((r) => {
      const a = r.hours / sh, perf = r.hours ? Math.min(1, r.fact / (r.plan / sh * r.hours)) : 0;
      const qr = q[r.date + "|" + areaOf(r.line)], qual = qr && qr.released ? 1 - qr.defects / qr.released : 1;
      const lost = Math.round((sh - r.hours) * 60), log = logged[r.date + "|" + areaOf(r.line)] || 0;
      return Object.assign({}, r, { availability: a, performance: perf, quality: qual, oee: a * perf * qual, lost, logged: log });
    });
    const quality = d.quality.map((r) => Object.assign({}, r, { rate: r.released ? r.defects / r.released : 0 }));
    const downs = Object.values(down);
    const planTotal = d.plan.reduce((a, r) => a + r.qty, 0);
    const lastArea = d.lines.length ? areaOf(d.lines[d.lines.length - 1].line) : null;
    const fin = d.lines.filter((r) => areaOf(r.line) === lastArea);
    const perShift = fin.length ? fin.reduce((a, r) => a + r.fact, 0) / fin.length : 0;
    const days = tg.working_days_month;
    return { tg, lines, quality, downs, planTotal, perShift, runRate: Math.round(perShift * tg.shifts_per_day * days),
      needPerShift: tg.plan_month_min / (tg.shifts_per_day * days) };
  }

  function renderData() {
    if (!DATA) return;
    const A = analyze(DATA), tg = A.tg, lim = tg.critical_downtime_min_per_day_max;
    document.getElementById("data-src").textContent = dataFiles ? t("data_src_user", { files: dataFiles.join(", ") }) : t("data_src_default");
    const days = document.getElementById("data-days");
    if (document.activeElement !== days) days.value = tg.working_days_month;
    // target cards
    const card = (label, norm, value, sub, ok, nBad, nAll) => `<div class="kpi ${ok ? "good" : "bad"}"><div class="label">${label} · ${norm}</div>
      <div class="value">${value}</div><div class="sub2">${sub}</div><div class="sub2"><b>${ok ? t("tg_ok") : t("tg_bad", { n: nBad, m: nAll })}</b></div></div>`;
    const minO = A.lines.reduce((a, r) => (!a || r.oee < a.oee ? r : a), null);
    const avgO = A.lines.reduce((a, r) => a + r.oee, 0) / Math.max(1, A.lines.length);
    const maxQ = A.quality.reduce((a, r) => (!a || r.rate > a.rate ? r : a), null);
    const maxD = A.downs.reduce((a, r) => (!a || r.minutes > a.minutes ? r : a), null);
    const badO = A.lines.filter((r) => r.oee < tg.oee_min).length, badQ = A.quality.filter((r) => r.rate > tg.defect_rate_max).length;
    const badD = A.downs.filter((r) => r.minutes > lim).length, gap = tg.plan_month_min - A.planTotal;
    document.getElementById("data-targets").innerHTML = [
      minO ? card(t("tg_oee"), t("tg_norm_min", { v: pct(tg.oee_min) }), pctL(minO.oee), t("tg_oee_sub", { avg: pctL(avgO) }), !badO, badO, A.lines.length) : "",
      maxQ ? card(t("tg_defect"), t("tg_norm_max", { v: pct(tg.defect_rate_max) }), pctL(maxQ.rate), t("tg_defect_sub", { area: dtr(maxQ.area), date: maxQ.date }), !badQ, badQ, A.quality.length) : "",
      maxD ? card(t("tg_down"), t("tg_norm_max", { v: `${lim} ${t("minutes")}` }), `${maxD.minutes}<small> ${t("minutes")}</small>`, t("tg_down_sub", { equip: dtr(maxD.equip), date: maxD.date }), !badD, badD, A.downs.length) : "",
      card(t("tg_plan"), t("tg_norm_min", { v: num(tg.plan_month_min) }), num(A.planTotal), gap > 0 ? t("tg_plan_sub", { gap: num(gap) }) : t("tg_plan_sub_ok"), gap <= 0, gap > 0 ? 1 : 0, 1),
    ].join("");
    // findings
    const F = [];
    const byArea = {};
    for (const r of A.quality) if (r.rate > tg.defect_rate_max) (byArea[r.area] = byArea[r.area] || []).push(r);
    for (const [area, rs] of Object.entries(byArea).sort((a, b) => b[1].length - a[1].length))
      F.push(["critical", t("f_quality", { area: dtr(area), rates: rs.map((r) => `${pctL(r.rate)} (${r.date})`).join(", "), limit: pct(tg.defect_rate_max) })]);
    if (gap > 0) F.push(["critical", t("f_plan_models", { models: DATA.plan.map((r) => `${r.model} ${num(r.qty)}`).join(", "), sum: num(A.planTotal), gap: num(gap), target: num(tg.plan_month_min) })]);
    F.push([A.runRate >= tg.plan_month_min ? "good" : "warning", t(A.runRate >= tg.plan_month_min ? "f_capacity_ok" : "f_capacity", { per: n1(A.perShift), shifts: tg.shifts_per_day, days: tg.working_days_month,
      rate: num(A.runRate), target: num(tg.plan_month_min), need: n1(Math.ceil(A.needPerShift * 10) / 10) })]);
    for (const r of A.downs.filter((x) => x.minutes > lim)) F.push(["critical", t("f_down_bad", { equip: dtr(r.equip), date: r.date, m: r.minutes, limit: lim })]);
    for (const r of A.downs.filter((x) => x.minutes <= lim && x.minutes >= 0.75 * lim)) F.push(["warning", t("f_down_near", { equip: dtr(r.equip), date: r.date, m: r.minutes, limit: lim })]);
    if (!A.downs.some((x) => x.minutes >= 0.75 * lim)) F.push(["good", t("f_down_ok", { limit: lim })]);
    if (badO) F.push(["warning", t("f_oee_bad", { limit: pct(tg.oee_min), list: A.lines.filter((r) => r.oee < tg.oee_min).map((r) => `${dtr(r.line)} ${r.date}: ${pctL(r.oee)}`).join(", ") })]);
    else if (minO) F.push(["good", t("f_oee_ok", { min: pctL(minO.oee), max: pctL(Math.max(...A.lines.map((r) => r.oee))), limit: pct(tg.oee_min), line: dtr(minO.line), date: minO.date, val: pctL(minO.oee) })]);
    const mism = A.lines.filter((r) => Math.abs(r.lost - r.logged) >= 15).sort((a, b) => Math.abs(b.lost - b.logged) - Math.abs(a.lost - a.logged));
    if (mism.length) F.push(["info", t("f_recon", { n: mism.length, m: A.lines.length, line: dtr(mism[0].line), date: mism[0].date, lost: mism[0].lost, logged: mism[0].logged })]);
    document.getElementById("data-findings").innerHTML = F.map(([sev, txt]) => `<li class="${sev}">${txt}</li>`).join("");
    // tables
    const cl = (ok, warn) => (ok ? "good" : warn ? "warn" : "bad");
    document.getElementById("data-lines").innerHTML = `<thead><tr><th>${t("col_date")}</th><th>${t("col_line")}</th><th>${t("col_plan")}</th><th>${t("col_fact")}</th><th>${t("col_hours")}</th>
      <th>${t("availability")}</th><th>${t("quality")}</th><th>OEE</th><th>${t("col_lost")}</th></tr></thead><tbody>` +
      A.lines.map((r) => `<tr><td>${r.date}</td><td>${dtr(r.line)}</td><td>${r.plan}</td><td>${r.fact}</td><td>${n1(r.hours)}</td>
        <td>${pctL(r.availability)}</td><td class="${cl(1 - r.quality <= tg.defect_rate_max)}">${pctL(r.quality)}</td>
        <td class="${cl(r.oee >= tg.oee_min + 0.03, r.oee >= tg.oee_min)}">${pctL(r.oee)}</td>
        <td class="${Math.abs(r.lost - r.logged) >= 15 ? "warn" : ""}">${r.lost} / ${r.logged}</td></tr>`).join("") + "</tbody>";
    document.getElementById("data-down").innerHTML = `<thead><tr><th>${t("col_date")}</th><th>${t("col_equip")}</th><th>${t("col_cause")}</th><th>${t("col_minutes")}</th></tr></thead><tbody>` +
      DATA.downtime.map((r) => { const tot = A.downs.find((x) => x.date === r.date && x.equip === r.equip).minutes;
        return `<tr><td>${r.date}</td><td>${dtr(r.equip)}<div class="muted small">${dtr(r.area)}</div></td><td>${dtr(r.cause)}</td>
        <td class="${cl(tot < 0.75 * lim, tot <= lim)}">${r.minutes}</td></tr>`; }).join("") + "</tbody>";
    document.getElementById("data-plan").innerHTML = `<thead><tr><th>${t("col_model")}</th><th>${t("col_qty")}</th></tr></thead><tbody>` +
      DATA.plan.map((r) => `<tr><td>${r.model}</td><td>${num(r.qty)}</td></tr>`).join("") +
      `<tr class="total"><td>${t("total")}</td><td class="${cl(gap <= 0)}">${num(A.planTotal)}</td></tr>
       <tr><td>${t("goal")}</td><td>${num(tg.plan_month_min)}</td></tr></tbody>`;
    // charts
    const dates = [...new Set(A.lines.map((r) => r.date))], lineNames = [...new Set(A.lines.map((r) => r.line))];
    const palette = [css("--accent"), css("--accent2"), css("--maintenance"), css("--blocked")];
    if (charts["c-data-oee"]) { charts["c-data-oee"].destroy(); delete charts["c-data-oee"]; }
    chart("c-data-oee", { type: "bar", data: { labels: lineNames.map(dtr), datasets: dates.map((dt, i) => ({ label: dt, backgroundColor: palette[i % 4],
        data: lineNames.map((ln) => { const r = A.lines.find((x) => x.line === ln && x.date === dt); return r ? +(r.oee * 100).toFixed(1) : null; }) }))
        .concat([{ type: "line", label: `${t("target")} ${pct(tg.oee_min)}`, data: lineNames.map(() => tg.oee_min * 100), borderColor: COLORS.down, borderDash: [6, 4], pointRadius: 0 }]) },
      options: { scales: { x: {}, y: { min: 70, max: 100 } } } });
    const areas = [...new Set(A.quality.map((r) => r.area))];
    if (charts["c-data-q"]) { charts["c-data-q"].destroy(); delete charts["c-data-q"]; }
    chart("c-data-q", { type: "bar", data: { labels: areas.map(dtr), datasets: [...new Set(A.quality.map((r) => r.date))].map((dt, i) => ({ label: dt,
        data: areas.map((ar) => { const r = A.quality.find((x) => x.area === ar && x.date === dt); return r ? +(r.rate * 100).toFixed(1) : null; }),
        backgroundColor: areas.map((ar) => { const r = A.quality.find((x) => x.area === ar && x.date === dt); return r && r.rate > tg.defect_rate_max ? (i ? "#f87171" : COLORS.down) : (i ? "#4ade80" : COLORS.working); }) }))
        .concat([{ type: "line", label: `${t("tg_norm_max", { v: pct(tg.defect_rate_max) })}`, data: areas.map(() => tg.defect_rate_max * 100), borderColor: COLORS.blocked, borderDash: [6, 4], pointRadius: 0 }]) },
      options: { scales: { x: {}, y: { beginAtZero: true } } } });
    renderDataTwin();
  }

  // live comparison: the twin's calibration against the organizer data
  function renderDataTwin() {
    if (!DATA || !S) return;
    const A = analyze(DATA), k = S.kpi, dr = k.defect_rate_by_shop || {};
    const e = metrics && metrics.effect, twinOut = e ? e.reactive.cars / e.days_per_seed / (e.shifts_per_day || 2) : null;
    const avgArea = (area) => { const rs = A.quality.filter((r) => r.area === area); return rs.length ? rs.reduce((a, r) => a + r.defects, 0) / rs.reduce((a, r) => a + r.released, 0) : null; };
    const avgFact = A.lines.reduce((a, r) => a + r.fact, 0) / Math.max(1, A.lines.length);
    const shopArea = { welding: "Сварка", paint: "Окраска", assembly: "Сборка" };
    const lim = A.tg.defect_rate_max;
    const col = (v) => `style="color:${v > lim ? COLORS.down : COLORS.working}"`;
    document.getElementById("data-twin").innerHTML = `
      <div class="row"><span>${t("tw_plan")}</span><b>${DATA.lines[0] ? DATA.lines[0].plan : "—"} / ${k.plan}</b></div>
      <div class="row"><span>${t("tw_shifts")}</span><b>${t("tw_shifts_val", { n: k.shifts_per_day })}</b></div>
      <div class="row"><span>${t("tw_out")}</span><b>${n1(avgFact)} / ${twinOut ? n1(twinOut) : "—"}</b></div>
      ${Object.entries(shopArea).map(([sh, ar]) => { const a = avgArea(ar); return a == null ? "" :
        `<div class="row"><span>${t("tw_def", { area: dtr(ar) })}</span><b><span ${col(a)}>${pctL(a)}</span> / <span ${col(dr[sh] || 0)}>${pctL(dr[sh] || 0)}</span></b></div>`; }).join("")}
      <div class="row"><span>${t("tw_equip")}</span><b class="small" style="text-align:right">${S.stations.filter((s) => /ABB|Камера|Конвейер/.test(s.equip || "")).map((s) => dtr(s.equip)).join(", ")}</b></div>
      <p class="muted small">${t("tw_note")}</p>`;
  }

  // CSV import: recognizes each organizer table by its header row (';' or ',' separated, decimal comma allowed)
  function parseCsv(text) {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return [];
    const sep = lines[0].includes(";") ? ";" : lines[0].includes("\t") ? "\t" : ",";
    const split = (l) => { const out = []; let cur = "", q = false;
      for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur.trim()); cur = ""; } else cur += ch; }
      out.push(cur.trim()); return out; };
    return lines.map(split);
  }
  const numv = (x) => parseFloat(String(x).replace(/\s/g, "").replace(",", "."));
  function tableFromCsv(rows) {
    const h = rows[0].map((x) => x.toLowerCase());
    const col = (...keys) => h.findIndex((c) => keys.some((k) => c.startsWith(k)));
    const body = rows.slice(1).filter((r) => r.length >= 2);
    if (col("линия") >= 0 && col("факт") >= 0) {
      const [d, l, p, f, hr] = [col("дата"), col("линия"), col("план"), col("факт"), col("время")];
      return ["lines", body.map((r) => ({ date: r[d], line: r[l], plan: numv(r[p]), fact: numv(r[f]), hours: numv(r[hr]) }))];
    }
    if (col("оборудование") >= 0) {
      const [d, a, e, c, m] = [col("дата"), col("участок"), col("оборудование"), col("причина"), col("длительность")];
      return ["downtime", body.map((r) => ({ date: r[d], area: r[a], equip: r[e], cause: r[c], minutes: numv(r[m]) }))];
    }
    if (col("модель") >= 0) {
      const [m, q] = [col("модель"), col("план")];
      return ["plan", body.map((r) => ({ model: r[m], qty: numv(r[q]) }))];
    }
    if (col("выпущено") >= 0 && col("брак") >= 0) {
      const [d, a, rel, def] = [col("дата"), col("участок"), col("выпущено"), h.findIndex((c) => c === "брак")];
      return ["quality", body.map((r) => ({ date: r[d], area: r[a], released: numv(r[rel]), defects: numv(r[def >= 0 ? def : col("брак")]) }))];
    }
    return [null, null];
  }
  document.getElementById("data-file").addEventListener("change", async (ev) => {
    const files = [...ev.target.files];
    if (!files.length || !DATA) return;
    const next = JSON.parse(JSON.stringify(DATA)), names = [];
    for (const f of files) {
      const [kind, rows] = tableFromCsv(parseCsv(await f.text()));
      if (!kind || !rows.length) { alert(t("data_import_err", { file: f.name })); continue; }
      next[kind] = rows; names.push(f.name);
    }
    if (names.length) { DATA = next; dataFiles = (dataFiles || []).concat(names); renderData(); }
    ev.target.value = "";
  });
  document.getElementById("data-reset").addEventListener("click", () => {
    DATA = JSON.parse(JSON.stringify(window.ALLUR_DATA)); dataFiles = null; renderData();
  });
  document.getElementById("data-days").addEventListener("input", (e) => {
    const v = Math.round(+e.target.value);
    if (DATA && v >= 1 && v <= 31) { DATA.targets.working_days_month = v; renderData(); }
  });

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
    if (LOCAL) det = LOCAL.station(selected);
    else try { det = await (await fetch("/api/station/" + selected)).json(); } catch { return; }
    const k = s.kpi, ai = s.ai;
    const body = document.getElementById("drawer-body");
    body.innerHTML = `
      <h2>${stName(s.id)}</h2>
      <div class="muted">${s.equip ? s.equip + " · " : ""}${t("shop_" + s.shop)}</div>
      <div class="section"><span class="pill" style="background:${COLORS[s.state]}">${t("s_" + s.state)}</span>
        ${s.state === "starved" ? `<span class="muted small"> ${t("s_hint_starved")}</span>` : s.state === "blocked" ? `<span class="muted small"> ${t("s_hint_blocked")}</span>` : ""}
        ${s.cause ? `<span class="small"> · ${t("c_" + s.cause)}</span>` : ""}
        ${s.down_left_min ? `<span class="small"> · ${s.down_left_min} ${t("minutes")}</span>` : ""}
        <div class="row" style="margin-top:6px"><span>${t("k_day_down")}</span><b style="color:${s.down_day_min > ((S.kpi.targets || {}).downtime_min_day || 60) ? COLORS.down : "inherit"}">${s.down_day_min} / ${(S.kpi.targets || {}).downtime_min_day || 60} ${t("minutes")}</b></div></div>
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
  let lastHist = 0, lastDrawer = 0, lastDataTwin = 0;
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
    if (tab === "data" && now - lastDataTwin > 3000) { lastDataTwin = now; renderDataTwin(); }
    if (selected && now - lastDrawer > 3000) { lastDrawer = now; renderDrawer(); }
  }

  // ------------------------------------------------------------------ events
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + b.dataset.tab));
    if (b.dataset.tab === "ai") renderMetrics();
    if (b.dataset.tab === "data") renderData();
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

  if (LOCAL) document.querySelectorAll("[data-server-only]").forEach((el) => (el.hidden = true));
  if (LOCAL) {
    document.querySelector('[data-i18n="model_desc"]').dataset.i18n = "model_desc_lite";
    document.querySelector('[data-i18n="app_sub"]').dataset.i18n = "app_sub_demo";
  }
  applyLang();
  connect();
  loadMetrics();
})();
