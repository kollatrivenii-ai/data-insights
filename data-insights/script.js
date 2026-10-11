"use strict";
const $ = (id) => document.getElementById(id);
let rows = [], cols = [], charts = {};

/* ---------- Helpers ---------- */
const isBlank = (v) => v === null || v === undefined || v === "" || (typeof v === "number" && isNaN(v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => {
  if (n === null || n === undefined || isNaN(n)) return "–";
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1000) return Math.round(n).toLocaleString();
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};
const quantile = (sorted, q) => {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ---------- Analysis ---------- */
function analyseColumn(name) {
  const raw = rows.map((r) => r[name]);
  const vals = raw.filter((v) => !isBlank(v));
  const missing = raw.length - vals.length;
  let type = "category";
  if (vals.length && vals.every((v) => typeof v === "number")) type = "numeric";
  else if (vals.length && vals.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v)))) type = "date";

  const info = { name, type, missing, count: vals.length, unique: new Set(vals).size };
  if (type === "numeric") {
    const s = [...vals].sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, s.length - 1));
    const q1 = quantile(s, 0.25), q3 = quantile(s, 0.75), iqr = q3 - q1;
    Object.assign(info, {
      mean, sd, min: s[0], max: s[s.length - 1], median: quantile(s, 0.5), q1, q3,
      outliers: s.filter((v) => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr).length,
    });
  } else if (type === "date") {
    const t = vals.map((v) => Date.parse(v)).sort((a, b) => a - b);
    info.min = new Date(t[0]).toISOString().slice(0, 10);
    info.max = new Date(t[t.length - 1]).toISOString().slice(0, 10);
  } else {
    const freq = {};
    vals.forEach((v) => (freq[v] = (freq[v] || 0) + 1));
    info.freq = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    info.top = info.freq[0] ? info.freq[0][0] : "–";
  }
  return info;
}

function pearson(a, b) {
  const xs = [], ys = [];
  rows.forEach((r) => {
    if (!isBlank(r[a]) && !isBlank(r[b])) { xs.push(r[a]); ys.push(r[b]); }
  });
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((p, c) => p + c, 0) / n, my = ys.reduce((p, c) => p + c, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

function duplicateCount() {
  const seen = new Set(); let d = 0;
  rows.forEach((r) => {
    const k = JSON.stringify(cols.map((c) => r[c.name]));
    seen.has(k) ? d++ : seen.add(k);
  });
  return d;
}

/* ---------- Rendering ---------- */
function render(filename) {
  cols = Object.keys(rows[0]).map(analyseColumn);
  const numeric = cols.filter((c) => c.type === "numeric");
  const totalCells = rows.length * cols.length;
  const missingCells = cols.reduce((a, c) => a + c.missing, 0);
  const dups = duplicateCount();

  $("fname").textContent = filename;
  $("overview").innerHTML = [
    [rows.length.toLocaleString(), "rows"],
    [cols.length, "columns"],
    [numeric.length, "numeric columns"],
    [((missingCells / totalCells) * 100).toFixed(1) + "%", "cells missing"],
    [dups, "duplicate rows"],
  ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");

  renderFindings(numeric, dups);
  renderColumnTable();
  renderHeatmap(numeric);
  renderPreview();

  const opts = (list) => list.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  $("distCol").innerHTML = opts(cols.filter((c) => c.type !== "date"));
  $("xCol").innerHTML = opts(numeric);
  $("yCol").innerHTML = opts(numeric);
  if (numeric.length > 1) $("yCol").selectedIndex = 1;

  $("report").classList.remove("hidden");
  drawDist();
  drawScatter();
  $("report").scrollIntoView({ behavior: "smooth" });
}

function renderFindings(numeric, dups) {
  const out = [];
  const worst = [...cols].sort((a, b) => b.missing - a.missing)[0];
  if (worst.missing > 0) out.push(`<b>${esc(worst.name)}</b> has the most gaps: ${worst.missing} of ${rows.length} values are missing (${((worst.missing / rows.length) * 100).toFixed(1)}%).`);
  else out.push("No missing values found.");
  if (dups) out.push(`${dups} rows are exact duplicates of another row.`);

  let best = null;
  for (let i = 0; i < numeric.length; i++)
    for (let j = i + 1; j < numeric.length; j++) {
      const r = pearson(numeric[i].name, numeric[j].name);
      if (r !== null && (!best || Math.abs(r) > Math.abs(best.r))) best = { a: numeric[i].name, b: numeric[j].name, r };
    }
  if (best && Math.abs(best.r) >= 0.3)
    out.push(`Strongest relationship: <b>${esc(best.a)}</b> and <b>${esc(best.b)}</b> (correlation ${best.r.toFixed(2)}, ${best.r > 0 ? "rise together" : "move in opposite directions"}).`);

  numeric.filter((c) => c.outliers > 0).sort((a, b) => b.outliers - a.outliers).slice(0, 2)
    .forEach((c) => out.push(`<b>${esc(c.name)}</b> has ${c.outliers} outlier${c.outliers > 1 ? "s" : ""} outside the usual range (min ${fmt(c.min)}, max ${fmt(c.max)}).`));

  numeric.filter((c) => c.sd && Math.abs(c.mean - c.median) / c.sd > 0.3).slice(0, 2)
    .forEach((c) => out.push(`<b>${esc(c.name)}</b> is skewed ${c.mean > c.median ? "right" : "left"}: the mean (${fmt(c.mean)}) differs from the median (${fmt(c.median)}).`));

  cols.filter((c) => c.type === "category" && c.freq && c.freq.length)
    .slice(0, 2).forEach((c) => out.push(`Most common <b>${esc(c.name)}</b>: ${esc(c.top)} (${c.freq[0][1]} rows, ${c.unique} distinct values).`));

  $("findings").innerHTML = out.map((t) => `<li>${t}</li>`).join("");
}

function renderColumnTable() {
  const head = ["Column", "Type", "Missing", "Unique", "Mean", "Median", "Std dev", "Min", "Max"];
  const body = cols.map((c) => {
    const n = c.type === "numeric";
    return `<tr><td><b>${esc(c.name)}</b></td><td><span class="tag ${c.type}">${c.type}</span></td>
      <td class="num">${c.missing}</td><td class="num">${c.unique}</td>
      <td class="num">${n ? fmt(c.mean) : "–"}</td><td class="num">${n ? fmt(c.median) : "–"}</td><td class="num">${n ? fmt(c.sd) : "–"}</td>
      <td class="num">${c.type === "category" ? "–" : n ? fmt(c.min) : c.min}</td><td class="num">${c.type === "category" ? "–" : n ? fmt(c.max) : c.max}</td></tr>`;
  }).join("");
  $("coltable").innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body}</tbody>`;
}

function renderHeatmap(numeric) {
  if (numeric.length < 2) { $("heat").innerHTML = "<tr><td class='muted'>Needs at least two numeric columns.</td></tr>"; return; }
  const teal = css("--c1"), amber = css("--c2");
  let h = "<thead><tr><th></th>" + numeric.map((c) => `<th>${esc(c.name)}</th>`).join("") + "</tr></thead><tbody>";
  numeric.forEach((a) => {
    h += `<tr><th>${esc(a.name)}</th>`;
    numeric.forEach((b) => {
      const r = a.name === b.name ? 1 : pearson(a.name, b.name);
      if (r === null) { h += "<td class='muted'>–</td>"; return; }
      const color = r >= 0 ? teal : amber;
      const pct = Math.round(Math.abs(r) * 70);
      h += `<td style="background:color-mix(in srgb, ${color} ${pct}%, transparent)">${r.toFixed(2)}</td>`;
    });
    h += "</tr>";
  });
  $("heat").innerHTML = h + "</tbody>";
}

function renderPreview() {
  const names = cols.map((c) => c.name);
  $("preview").innerHTML = `<thead><tr>${names.map((n) => `<th>${esc(n)}</th>`).join("")}</tr></thead><tbody>` +
    rows.slice(0, 10).map((r) => `<tr>${names.map((n) => `<td>${isBlank(r[n]) ? '<span class="muted">empty</span>' : esc(r[n])}</td>`).join("")}</tr>`).join("") + "</tbody>";
}

/* ---------- Charts ---------- */
function resetChart(key) { if (charts[key]) charts[key].destroy(); }
function chartDefaults() {
  Chart.defaults.color = css("--muted");
  Chart.defaults.borderColor = css("--line");
  Chart.defaults.font.family = '"Manrope", system-ui, sans-serif';
}

function drawDist() {
  chartDefaults(); resetChart("dist");
  const c = cols.find((x) => x.name === $("distCol").value);
  if (!c) return;
  let labels, data;
  if (c.type === "numeric") {
    const vals = rows.map((r) => r[c.name]).filter((v) => !isBlank(v));
    const bins = Math.min(20, Math.ceil(Math.log2(vals.length)) + 1);
    const width = (c.max - c.min) / bins || 1;
    data = new Array(bins).fill(0);
    vals.forEach((v) => data[Math.min(bins - 1, Math.floor((v - c.min) / width))]++);
    labels = data.map((_, i) => fmt(c.min + i * width));
  } else {
    const top = c.freq.slice(0, 12);
    labels = top.map((t) => t[0]); data = top.map((t) => t[1]);
  }
  charts.dist = new Chart($("distChart"), {
    type: "bar",
    data: { labels, datasets: [{ label: "Rows", data, backgroundColor: css("--c1"), borderRadius: 3, categoryPercentage: 0.95, barPercentage: 0.95 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, title: { display: true, text: c.type === "numeric" ? `Distribution of ${c.name}` : `Most common values in ${c.name}`, color: css("--ink") } } },
  });
}

function drawScatter() {
  chartDefaults(); resetChart("scatter");
  const x = $("xCol").value, y = $("yCol").value;
  if (!x || !y) { $("scatterNote").textContent = "Needs at least two numeric columns."; return; }
  const pts = rows.filter((r) => !isBlank(r[x]) && !isBlank(r[y])).map((r) => ({ x: r[x], y: r[y] }));
  const r = x === y ? 1 : pearson(x, y);
  $("scatterNote").textContent = r === null ? "" : `Correlation: ${r.toFixed(2)} across ${pts.length} rows.`;
  charts.scatter = new Chart($("scatterChart"), {
    type: "scatter",
    data: { datasets: [{ data: pts, backgroundColor: css("--c3"), pointRadius: 3 }] },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { title: { display: true, text: x } }, y: { title: { display: true, text: y } } },
    },
  });
}

/* ---------- Loading data ---------- */
function load(text, filename) {
  $("err").textContent = "";
  const res = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
  if (!res.data.length || !res.meta.fields || res.meta.fields.length < 1) {
    $("err").textContent = "That file has no readable rows. Check that the first line holds column names.";
    return;
  }
  rows = res.data;
  render(filename);
}

function readFile(f) {
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => load(reader.result, f.name);
  reader.onerror = () => ($("err").textContent = "Could not read that file. Try another CSV.");
  reader.readAsText(f);
}

function sampleCsv() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const regions = ["North", "South", "East", "West"], products = ["Laptop", "Phone", "Tablet", "Monitor", "Headset"];
  const base = { Laptop: 900, Phone: 650, Tablet: 400, Monitor: 250, Headset: 90 };
  let csv = "date,region,product,units,unit_price,discount,revenue,rating\n";
  for (let i = 0; i < 240; i++) {
    const d = new Date(Date.UTC(2025, 0, 1) + Math.floor(rnd() * 365) * 864e5).toISOString().slice(0, 10);
    const p = products[Math.floor(rnd() * products.length)], r = regions[Math.floor(rnd() * regions.length)];
    const price = Math.round(base[p] * (0.9 + rnd() * 0.2));
    const units = 1 + Math.floor(rnd() * rnd() * 20);
    const disc = Math.round(rnd() * 20) / 100;
    const rev = Math.round(units * price * (1 - disc));
    const rating = rnd() < 0.08 ? "" : (3 + rnd() * 2 - disc * 3).toFixed(1);
    csv += `${d},${r},${p},${units},${price},${disc},${rev},${rating}\n`;
  }
  return csv;
}

/* ---------- Events ---------- */
$("pick").onclick = () => $("file").click();
$("file").onchange = (e) => readFile(e.target.files[0]);
$("sample").onclick = () => load(sampleCsv(), "sample-sales.csv");
$("distCol").onchange = drawDist;
$("xCol").onchange = drawScatter;
$("yCol").onchange = drawScatter;
const drop = $("drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => readFile(e.dataTransfer.files[0]));
