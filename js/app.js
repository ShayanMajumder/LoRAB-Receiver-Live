// LoRAB Receiver web app: UI, radio control (Airspy or RTL-SDR), and the bridge to the DSP workers.

import { requestRadio, pairedRadio, isRadio } from "./radio.js";
import { frameLayout, channelRateFor, AWGN_OFF } from "./dsp.js";

const FM_LOW = 87.5e6, FM_HIGH = 108e6;
const USABLE = 0.42;              // Usable fraction of the sample rate on each side of the centre
const CHANNEL_HALF = 115e3;       // A station needs this much on each side of its carrier
const MAX_PENDING = 48;           // USB buffers queued for the worker before we drop (about 1 s)
const STORE = "lorab-settings", NAMES = "lorab-names";

const DEFAULTS = {
  auto: true, rate: 0, agc: true, gain: 14, deemph: 50,
  sf: 9, bw: 10000, subcarrier: 48, msgLen: 16, txPeriod: 4, nDown: 8, nUp: 3,
  helpers: 4, combine: 8, awgnOn: false, awgnSnr: -22,
};

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const mhz = (f) => (f / 1e6).toFixed(1);

const S = {
  set: load(STORE, DEFAULTS),
  names: load(NAMES, {}),        // RDS station names by frequency (Hz)
  tags: new Map(),               // Find-my-tag results by frequency
  dev: null,
  demo: false,
  fs: 3e6,
  rates: [3e6, 6e6],
  stations: [],
  band: [],
  view: "connect",
  scanning: false,
  finding: false,
  probe: null,
  listen: null,
  pending: 0,
  dropped: 0,
};

// ======================================================================= workers
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let waiters = [];

worker.onmessage = ({ data: m }) => {
  waiters = waiters.filter((w) => !w(m));
  switch (m.type) {
    case "frame": onFrame(m.ev); break;
    case "display": onDisplay(m); break;
    case "load": onLoad(m); break;
    case "rds": onRds(m); break;
    case "audio": playAudio(m.pcm); break;
    case "log": console.info("[LoRAB]", m.text); break;
    case "error": toast(`Processing error: ${m.message}`); break;
  }
};
worker.onerror = (e) => toast(`Processing error: ${e.message || "worker failed to start"}`);

// One station worker per spare core: each station is demodulated in parallel
(function startPool() {
  const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 2));
  const ports = [];
  for (let i = 0; i < n; i++) {
    const w = new Worker(new URL("./station-worker.js", import.meta.url), { type: "module" });
    const ch = new MessageChannel();
    w.postMessage({ type: "port", port: ch.port2 }, [ch.port2]);
    w.onerror = (e) => toast(`Processing error: ${e.message || "station worker failed"}`);
    ports.push(ch.port1);
  }
  worker.postMessage({ type: "pool", ports }, ports);
})();

function request(msg, type, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== check);
      reject(new Error("No samples from the radio. Replug it and try again."));
    }, timeout);
    const check = (m) => {
      if (m.type !== type) return false;
      clearTimeout(timer);
      resolve(m);
      return true;
    };
    waiters.push(check);
    worker.postMessage(msg);
  });
}

// ======================================================================= storage
function load(key, defaults) {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(key) || "{}") };
  } catch {
    return { ...defaults };
  }
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

function tagCfg() {
  const s = S.set;
  return { sf: s.sf, bw: s.bw, nDown: s.nDown, nUp: s.nUp, msgLen: s.msgLen, txPeriod: s.txPeriod,
    maxCombine: s.combine, subcarrier: s.subcarrier * 1000, chanRate: channelRateFor(s.subcarrier * 1000, s.bw) };
}

const awgnValue = () => (S.set.awgnOn ? S.set.awgnSnr : AWGN_OFF);
const stationName = (f) => S.names[Math.round(f / 1e5) * 1e5] || "";

// ======================================================================= views
function show(view) {
  S.view = view;
  for (const v of ["connect", "scan", "listen"]) $(`#view${v[0].toUpperCase()}${v.slice(1)}`).hidden = v !== view;
  const order = ["connect", "scan", "listen"];
  document.querySelectorAll(".steps li").forEach((li) => {
    const i = order.indexOf(li.dataset.step), cur = order.indexOf(view);
    li.classList.toggle("active", i === cur);
    li.classList.toggle("done", i < cur);
  });
  if (view === "scan") requestAnimationFrame(drawBand);
}

function setPill(text, cls) {
  const p = $("#devicePill");
  p.textContent = text;
  p.className = `pill ${cls || ""}`;
}

let toastTimer;
function toast(text, ms = 4500) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ======================================================================= connect
function explain(e, dev = S.dev || S.opening) {
  const msg = `${e.name || ""} ${e.message || e}`;
  const rtl = dev?.format === "rtl", name = rtl ? "RTL-SDR" : dev ? "Airspy" : "radio";
  if (/access|security|permission|LIBUSB_ERROR_ACCESS/i.test(msg))
    return `The browser isn't allowed to open the ${name}. On Linux, add the udev rule below, replug it and try again.`;
  if (/claim|busy|InvalidState/i.test(msg))
    return rtl
      ? "The RTL-SDR is in use. Close other radio programs and LoRAB tabs. On Linux, the TV-tuner driver may hold it: run the blacklist command below, then replug it."
      : `The ${name} is in use by another program or tab. Close GNU Radio, SDR++, SDR# or other LoRAB tabs and try again.`;
  if (/open|NetworkError/i.test(msg))
    return `The ${name} couldn't be opened. On Windows it needs the WinUSB driver (see below); otherwise replug it and try again.`;
  return `Couldn't start the ${name}: ${e.message || e}`;
}

async function connect(paired) {
  if (S.connecting || S.dev) return;
  S.connecting = true;
  try {
    await openRadio(paired);
  } finally {
    S.connecting = false;
  }
}

async function openRadio(paired) {
  $("#connectError").hidden = true;
  if (!("usb" in navigator)) {
    showConnectError(window.isSecureContext
      ? "This browser can't talk to USB devices. Use Chrome, Edge or Opera, or try the demo."
      : "USB needs a secure page. Open this site over https:// or http://localhost.");
    return;
  }
  try {
    const dev = paired ? await pairedRadio() : await requestRadio();
    if (!dev) return;
    S.opening = dev;
    await dev.open();
    S.dev = dev;
    S.demo = false;
    S.rates = [...dev.sampleRates].sort((a, b) => a - b);
    S.fs = S.rates.includes(S.set.rate) ? S.set.rate : S.rates[0];
    await dev.setSampleRate(S.fs);
    await applyGain();
    worker.postMessage({ type: "reset", fs: S.fs, format: dev.format });
    await startStream();
    setPill(dev.name, "on");
    fillRateSelect();
    show("scan");
    autoStart();
  } catch (e) {
    if (e.name === "NotFoundError") return;   // Chooser closed
    console.error(e);
    showConnectError(explain(e));
    try { await (S.dev || S.opening)?.close(); } catch { /* ignore */ }
    S.dev = null;
  } finally {
    S.opening = null;
  }
}

function showConnectError(text) {
  const p = $("#connectError");
  p.textContent = text;
  p.hidden = false;
}

async function startStream() {
  S.pending = 0;
  await S.dev.start((buf) => {
    if (S.pending > MAX_PENDING) { S.dropped++; return; }
    S.pending++;
    worker.postMessage({ type: "raw", buf }, [buf]);
  }, onDeviceLost);
}

function onDeviceLost() {
  if (!S.dev) return;
  S.dev = null;
  S.listen = null;
  S.abortFind = true;
  setPill("No radio");
  show("connect");
  showConnectError("The radio stopped responding or was unplugged. Plug it back in and connect again.");
}

async function disconnect() {
  worker.postMessage({ type: "stop" });
  S.abortFind = true;
  const d = S.dev;
  S.dev = null;
  S.demo = false;
  S.listen = null;
  if (d) await d.close();
  setPill("No radio");
  closeSettings();
  show("connect");
  refreshConnectButton();
}

function startDemo() {
  S.demo = true;
  S.dev = null;
  S.rates = [3e6, 6e6];
  S.fs = S.rates.includes(S.set.rate) ? S.set.rate : 3e6;
  worker.postMessage({ type: "reset", fs: S.fs });
  worker.postMessage({ type: "demo", fs: S.fs });
  setPill("Demo (simulated radio)", "demo");
  fillRateSelect();
  show("scan");
  autoStart();
}

/** Scan, then (if enabled) find the tag and listen to the best station. */
async function autoStart() {
  await scan();
  if (!S.set.auto || !S.stations.length || S.view !== "scan" || S.listen) return;
  await findTag();
  const best = bestTagStation();
  if (best && S.view === "scan" && !S.listen && !S.abortFind) listenTo(best);
}

async function applyGain() {
  if (!S.dev) return;
  if (S.set.agc) await S.dev.setAgc(true);
  else await S.dev.setLinearityGain(S.set.gain);
}

async function refreshConnectButton() {
  if (!("usb" in navigator)) return;
  try {
    $("#connectBtn").dataset.paired = (await pairedRadio()) ? "1" : "";
  } catch { /* ignore */ }
}

// ======================================================================= scan
async function scan() {
  if (S.scanning || S.finding) return;
  S.scanning = true;
  S.abortScan = false;
  worker.postMessage({ type: "stop" });
  S.listen = null;
  if (S.demo) worker.postMessage({ type: "demo", fs: S.fs });
  const fs = S.fs, usable = USABLE * fs, step = 2 * usable - 300e3;
  const centers = [];
  for (let fc = FM_LOW + usable - 100e3; fc - usable < FM_HIGH + 100e3; fc += step) centers.push(fc);
  S.stations = [];
  S.band = [];
  S.tags.clear();
  $("#bestBar").hidden = true;
  renderStationGrid();
  setBusy(true);
  $("#noStations").hidden = true;
  const prog = $("#scanProgress");
  prog.hidden = false;
  try {
    for (const [i, fc] of centers.entries()) {
      setProgress(i / centers.length, `Scanning ${mhz(fc)} MHz…`);
      if (S.dev) await S.dev.setFrequency(fc);
      const r = await request({ type: "scanStep", centerHz: fc, skip: Math.round(0.4 * fs),
        take: Math.round(0.4 * fs), usable }, "scanResult");
      if (S.abortScan) break;                 // A station was picked mid-scan
      S.band.push({ center: fc, fs, usable, spectrum: r.spectrum });
      for (const s of r.stations) {
        if (s.freq < FM_LOW || s.freq > FM_HIGH) continue;
        const off = Math.abs(s.freq - fc), prev = S.stations.find((p) => p.freq === s.freq);
        if (!prev) S.stations.push({ ...s, off });
        else if (off < prev.off) Object.assign(prev, s, { off });
      }
      S.stations.sort((a, b) => a.freq - b.freq);
      drawBand();
      renderStationGrid();
    }
    setProgress(1, `Found ${S.stations.length} station${S.stations.length === 1 ? "" : "s"}`);
    $("#noStations").hidden = S.stations.length > 0;
    setTimeout(() => { if (!S.finding) prog.hidden = true; }, 1500);
  } catch (e) {
    prog.hidden = true;
    if (!S.abortScan) toast(e.message);
  } finally {
    S.scanning = false;
    setBusy(false);
  }
}

function setBusy(on) {
  $("#scanBtn").disabled = on;
  $("#findBtn").disabled = on || !S.stations.length;
}

function setProgress(frac, text) {
  $("#scanProgress").hidden = false;
  $("#scanProgress .bar").style.width = `${Math.round(frac * 100)}%`;
  $("#scanProgress .progress-text").textContent = text;
}

function strengthBars(snr) {
  return [8, 14, 20, 26].filter((t) => snr >= t).length;
}

function renderStationGrid() {
  const g = $("#stationGrid");
  g.replaceChildren();
  const best = bestTagStation();
  for (const s of S.stations) {
    const b = el("button", `station${best && best.freq === s.freq ? " best" : ""}`);
    const f = el("div", "freq", mhz(s.freq));
    f.append(el("small", "", "MHz"));
    const bars = el("span", "bars");
    const n = strengthBars(s.snr);
    for (let i = 0; i < 4; i++) bars.append(el("i", i < n ? "on" : ""));
    const st = el("div", "strength");
    st.append(bars, ["Weak", "Weak", "Fair", "Good", "Strong"][n]);
    b.append(f, el("div", "name", stationName(s.freq)), st);
    const t = S.tags.get(s.freq);
    if (t) b.append(el("span", `tagbadge ${t.state}`, t.state === "checking" ? "Checking…"
      : t.state === "heard" ? `Tag ${t.snr.toFixed(1)} dB` : "No tag"));
    b.append(el("span", "go", "Listen →"));
    b.addEventListener("click", () => listenTo(s));
    b.title = `${mhz(s.freq)} MHz, ${s.snr.toFixed(0)} dB above the noise`;
    g.append(b);
  }
  setBusy(S.scanning || S.finding);
}

// ======================================================================= find my tag
/** Capture windows that cover all stations with as few retunes as possible. */
function planWindows() {
  const half = USABLE * S.fs - CHANNEL_HALF, out = [];
  for (let i = 0; i < S.stations.length;) {
    const center = Math.round((S.stations[i].freq + half) / 1e3) * 1e3;
    const inside = S.stations.filter((s) => Math.abs(s.freq - center) <= half);
    out.push({ center, stations: inside });
    while (i < S.stations.length && S.stations[i].freq <= center + half) i++;
  }
  return out;
}

function bestTagStation() {
  let best = null;
  for (const s of S.stations) {
    const t = S.tags.get(s.freq);
    if (t?.state === "heard" && (!best || t.snr > S.tags.get(best.freq).snr)) best = s;
  }
  return best;
}

async function findTag() {
  if (S.finding || S.scanning || !S.stations.length) return;
  S.finding = true;
  S.abortFind = false;
  $("#bestBar").hidden = true;
  const wins = planWindows(), L = frameLayout(tagCfg());
  S.stations.forEach((s) => S.tags.set(s.freq, { state: "checking" }));
  renderStationGrid();
  try {
    for (const [i, w] of wins.entries()) {
      if (S.abortFind) break;
      setProgress(i / wins.length,
        `Listening for your tag on ${w.stations.map((s) => mhz(s.freq)).join(", ")} MHz (${i + 1} of ${wins.length})…`);
      if (S.dev) await S.dev.setFrequency(w.center);
      const res = await probe(w, (S.set.txPeriod + L.seconds + 1.5) * 1000);
      for (const s of w.stations) {
        const r = res.get(mhz(s.freq));
        S.tags.set(s.freq, r && (r.ok || r.snr > -16) ? { state: "heard", snr: r.snr } : { state: "none" });
      }
      renderStationGrid();
    }
  } finally {
    worker.postMessage({ type: "stop" });
    S.finding = false;
    S.probe = null;
  }
  if (S.abortFind) return;
  setProgress(1, "Done");
  setTimeout(() => ($("#scanProgress").hidden = true), 1200);
  const best = bestTagStation(), bar = $("#bestBar");
  bar.hidden = false;
  bar.classList.toggle("none", !best);
  $("#bestBtn").hidden = !best;
  $("#bestText").textContent = best
    ? `Your tag is strongest on ${mhz(best.freq)} MHz${stationName(best.freq) ? ` (${stationName(best.freq)})` : ""}: ${S.tags.get(best.freq).snr.toFixed(1)} dB.`
    : "No tag heard. Check the tag is powered and its settings match (Settings → Tag signal).";
  renderStationGrid();
}

/** Listens to a window until a frame is found (or timeout); per-station SNR and decode result. */
function probe(w, timeout) {
  return new Promise((resolve) => {
    const res = new Map();
    let frames = 0, timer;
    const finish = () => { clearTimeout(timer); S.probe = null; resolve(res); };
    S.probe = (ev) => {
      for (const st of ev.stations) {
        const prev = res.get(st.label);
        if (!prev || st.snr > prev.snr) res.set(st.label, { snr: st.snr, ok: st.ok || prev?.ok });
      }
      if (ev.text !== null || ++frames >= 2) finish();
    };
    timer = setTimeout(finish, timeout);
    worker.postMessage({ type: "listen", centerHz: w.center, stations: w.stations.map((s) => ({ freq: s.freq })),
      cfg: tagCfg(), awgn: AWGN_OFF });
  });
}

// ======================================================================= listen
function planCapture(main) {
  const half = USABLE * S.fs - CHANNEL_HALF;
  const others = S.stations.filter((s) => s.freq !== main.freq);
  const value = (s) => S.tags.get(s.freq)?.state === "heard" ? 1000 + S.tags.get(s.freq).snr : s.snr;
  let best = null;
  for (let c = main.freq - half; c <= main.freq + half + 1; c += 25e3) {
    const inside = others.filter((s) => Math.abs(s.freq - c) <= half)
      .sort((a, b) => value(b) - value(a)).slice(0, S.set.helpers);
    const score = inside.length * 10000 + inside.reduce((a, s) => a + value(s), 0) - Math.abs(c - main.freq) / 1e5;
    if (!best || score > best.score) best = { score, center: Math.round(c / 1e3) * 1e3, helpers: inside };
  }
  best.helpers.sort((a, b) => a.freq - b.freq);
  return best;
}

function listenTo(main) {
  if (S.scanning) S.abortScan = true;
  if (S.finding) S.abortFind = true;
  const plan = planCapture(main);
  S.listen = {
    main, center: plan.center,
    helpers: plan.helpers.map((h) => ({ ...h, on: true })),
    results: new Map(), spec: null, gotText: false, packets: [], snrs: [],
    yMin: -100, yMax: -40, nf: null,
  };
  $("#packetRows").replaceChildren();
  $("#noPackets").hidden = false;
  setMessageWaiting("Waiting for the tag…");
  $("#msgMeta").replaceChildren();
  show("listen");
  startListen();
}

function activeStations() {
  const L = S.listen;
  return [L.main, ...L.helpers.filter((h) => h.on)];
}

async function startListen() {
  const L = S.listen;
  if (!L) return;
  try {
    if (S.dev) await S.dev.setFrequency(L.center);
  } catch (e) {
    toast(explain(e));
    return;
  }
  worker.postMessage({ type: "listen", centerHz: L.center, stations: activeStations().map((s) => ({ freq: s.freq })),
    cfg: tagCfg(), awgn: awgnValue(), audio: S.audio.on, deemph: S.set.deemph * 1e-6 });
  S.audio.t = 0;
  L.snrs = [];
  renderListenHeader();
  $("#statDecoded").textContent = "0";
  $("#statSeen").textContent = "of 0 frames";
  $("#statSnr").textContent = "–";
  drawSpark();
  const cw = $("#chirpCanvas");   // One frame period across the waterfall (a column is 32 samples)
  cw.width = Math.max(600, Math.min(2400, Math.round((S.set.txPeriod * S.set.bw) / 32)));
  clearChirps();
  updateAwgnBadge();
  renderStationRows();
}

function renderListenHeader() {
  const L = S.listen;
  if (!L) return;
  const name = stationName(L.main.freq);
  $("#listenTitle").textContent = `Listening on ${mhz(L.main.freq)} MHz${name ? ` · ${name}` : ""}`;
  const sub = $("#listenSub");
  sub.replaceChildren();
  const label = (s, role) => `${mhz(s.freq)} MHz${stationName(s.freq) ? ` ${stationName(s.freq)}` : ""} · ${role}`;
  sub.append(el("span", "chip main", label(L.main, "main")));
  const helpers = L.helpers.filter((h) => h.on);
  helpers.forEach((h) => sub.append(el("span", "chip", label(h, "helper"))));
  if (!L.helpers.length) sub.append(el("span", "muted small", "No other stations fit in the bandwidth"));
  $("#chirpTitle").textContent = `Tag chirps on ${mhz(L.main.freq)} MHz`;
}

function setMessageWaiting(text) {
  const m = $("#msgText");
  m.className = "msg waiting";
  m.replaceChildren(el("span", "dot"), text);
}

function onFrame(ev) {
  if (S.probe) { S.probe(ev); return; }
  const L = S.listen;
  if (!L) return;
  ev.at = new Date();
  ev.stations.forEach((s) => L.results.set(s.label, s));
  L.packets.unshift(ev);
  if (L.packets.length > 200) L.packets.pop();
  L.snrs.push({ snr: ev.snr, ok: ev.text !== null });
  if (L.snrs.length > 40) L.snrs.shift();
  renderStationRows();
  addPacketRow(ev);
  drawSpark();
  $("#statSnr").textContent = `${ev.snr.toFixed(1)} dB`;
  if (ev.text !== null) {
    L.gotText = true;
    const m = $("#msgText");
    m.className = "msg";
    m.textContent = ev.text;
    void m.offsetWidth;
    m.classList.add("fresh");
    $("#msgMeta").replaceChildren(
      el("span", "", ev.at.toLocaleTimeString()),
      el("span", "", `SNR ${ev.snr.toFixed(1)} dB`),
      el("span", "", ev.stations.length > 1 ? `${ev.stations.length} stations combined` : "1 station"),
      el("span", "", ev.frames > 1 ? `${ev.frames} frames combined` : "single frame"),
      ...(ev.inspect.errors ? [el("span", "", `${ev.inspect.errors} symbol errors corrected`)] : []),
    );
  } else if (!L.gotText) {
    setMessageWaiting(`Frame found. Collecting more to combine (${ev.pending} of up to ${S.set.combine})…`);
  }
}

function addPacketRow(ev) {
  const body = $("#packetRows");
  $("#noPackets").hidden = true;
  const tr = el("tr", ev.text === null ? "pending new" : "new");
  tr.append(
    el("td", "", ev.at.toLocaleTimeString()),
    el("td", "text", ev.text === null ? `not decoded yet (${ev.pending} pending)` : ev.text),
    el("td", "", `${ev.snr.toFixed(1)} dB${ev.awgn !== null ? " *" : ""}`),
    el("td", "", ev.stations.map((s) => `${s.label} ${s.ok ? "✓" : "·"}`).join("  ")),
    el("td", "", ev.text === null ? "–" : String(ev.frames)),
  );
  if (ev.awgn !== null) tr.title = `Noise test active: in-band SNR set to ${ev.awgn} dB`;
  tr.addEventListener("click", () => openInspector(ev));
  body.prepend(tr);
  while (body.children.length > 200) body.lastChild.remove();
}

function renderStationRows() {
  const L = S.listen, ul = $("#stationRows");
  if (!L) return;
  ul.replaceChildren();
  const all = [{ ...L.main, main: true, on: true }, ...L.helpers];
  for (const s of all) {
    const label = mhz(s.freq), r = L.results.get(label);
    const li = el("li", s.on ? "" : "off");
    const name = el("span", "f", `${label} MHz`);
    name.append(el("span", "role", [s.main ? "Main station" : "Helper", stationName(s.freq)].filter(Boolean).join(" · ")));
    const snr = el("span", "snr", r && s.on ? `${r.snr.toFixed(1)} dB` : "–");
    const res = el("span", `res ${r?.ok ? "ok" : "no"}`, r && s.on ? (r.ok ? "✓" : "–") : "");
    res.title = "Did this station decode the last frame on its own?";
    li.append(el("span", `swatch ${s.main ? "main" : ""}`), name, snr);
    if (s.main) li.append(res);
    else {
      const wrap = el("span", "");
      const t = el("input", "switch");
      t.type = "checkbox";
      t.checked = s.on;
      t.title = "Use this station";
      t.addEventListener("change", () => {
        L.helpers.find((h) => h.freq === s.freq).on = t.checked;
        startListen();
      });
      wrap.append(res, " ", t);
      li.append(wrap);
    }
    ul.append(li);
  }
}

function onDisplay(m) {
  const L = S.listen;
  if (!L || S.view !== "listen" || S.probe) return;
  drawSpectrum(m);
  drawChirps(m.wf, m.wfBins);
  $("#statDecoded").textContent = String(m.decoded);
  const rate = m.seen ? ` (${Math.round((100 * m.decoded) / m.seen)}%)` : "";
  $("#statSeen").textContent = `of ${m.seen} frame${m.seen === 1 ? "" : "s"}${rate}`;
  const lk = $("#statLock");
  lk.textContent = m.locked ? "Locked" : "Searching";
  lk.className = m.locked ? "ok" : "";
}

function onLoad(m) {
  S.pending = Math.max(0, S.pending - m.processed);
  const pct = Math.round((m.load + m.stations) * 100);
  $("#statLoad").textContent = `CPU ${pct}% · ${m.threads} thread${m.threads === 1 ? "" : "s"}`;
  if (S.dropped || m.dropped) {
    toast("This computer can't keep up. Lower the bandwidth or the number of helper stations in Settings.");
    S.dropped = 0;
  }
}

function onRds(m) {
  if (!m.ps) return;
  const key = Math.round(m.freq / 1e5) * 1e5;
  if (S.names[key] === m.ps) return;
  S.names[key] = m.ps;
  save(NAMES, S.names);
  if (S.view === "scan") renderStationGrid();
  renderListenHeader();
  renderStationRows();
}

function updateAwgnBadge() {
  const b = $("#awgnBadge");
  b.hidden = !S.set.awgnOn;
  b.textContent = `Noise test · ${S.set.awgnSnr.toFixed(1)} dB SNR`;
}

function exportCsv() {
  const L = S.listen;
  if (!L?.packets.length) { toast("No packets yet."); return; }
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [["time", "message", "snr_db", "frames_combined", "symbol_errors_corrected", "stations", "noise_test_db"]];
  for (const p of [...L.packets].reverse()) {
    rows.push([p.at.toISOString(), p.text ?? "", p.snr.toFixed(2), p.text === null ? "" : p.frames,
      p.inspect.errors ?? "", p.stations.map((s) => `${s.label}:${s.snr.toFixed(1)}:${s.ok ? "ok" : "-"}`).join(" "),
      p.awgn ?? ""]);
  }
  const blob = new Blob([rows.map((r) => r.map(q).join(",")).join("\n")], { type: "text/csv" });
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = `lorab-packets-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ======================================================================= audio
S.audio = { ctx: null, gain: null, on: false, t: 0 };

/** Plays the main station's mono audio (50 kHz chunks from the worker). */
async function toggleAudio() {
  const A = S.audio;
  A.on = !A.on;
  if (A.on && !A.ctx) {
    A.ctx = new AudioContext({ sampleRate: 50000, latencyHint: "playback" });
    A.gain = A.ctx.createGain();
    A.gain.gain.value = Number($("#volume").value);
    A.gain.connect(A.ctx.destination);
  }
  if (A.on) await A.ctx.resume();
  A.t = 0;
  worker.postMessage({ type: "audio", on: A.on, deemph: S.set.deemph * 1e-6 });
  const b = $("#audioBtn");
  b.setAttribute("aria-pressed", String(A.on));
  b.querySelector("span").textContent = A.on ? "Stop audio" : "Play audio";
}

function playAudio(pcm) {
  const A = S.audio;
  if (!A.on || !A.ctx || !pcm.length) return;
  const now = A.ctx.currentTime;
  // Keep 0.15-0.8 s of audio queued; the radio and sound card clocks drift apart slowly
  if (A.t < now + 0.05) A.t = now + 0.15;
  if (A.t > now + 0.8) return;
  const buf = A.ctx.createBuffer(1, pcm.length, 50000);
  buf.copyToChannel(pcm, 0);
  const src = A.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(A.gain);
  src.start(A.t);
  A.t += pcm.length / 50000;
}

// ======================================================================= packet inspector
function openInspector(ev) {
  const d = $("#inspector"), I = ev.inspect;
  $("#insTitle").textContent = ev.text === null ? "Frame (not decoded yet)" : `“${ev.text}”`;
  $("#insSub").textContent = `${ev.at.toLocaleTimeString()} · symbol map from ${I.label} MHz`;
  const facts = $("#insFacts");
  facts.replaceChildren();
  const fact = (k, v) => { const w = el("div"); w.append(el("dt", "", k), el("dd", "", v)); facts.append(w); };
  fact("Signal", `${ev.snr.toFixed(1)} dB in-band SNR`);
  fact("Stations", ev.stations.map((s) => `${s.label} MHz ${s.snr.toFixed(1)} dB ${s.ok ? "✓" : "·"}`).join("\n"));
  fact("Combined", ev.text === null ? `waiting (${ev.pending} frames so far)` : ev.frames > 1 ? `${ev.frames} frames` : "single frame");
  if (I.errors !== null) fact("Error correction", `${I.errors} of ${I.nData} symbols were wrong and got fixed`);
  fact("Frame", `${I.nPre} preamble + ${I.nData} data chirps, SF${S.set.sf}`);
  d.showModal();
  requestAnimationFrame(() => drawInspector(I));
}

function drawInspector(I) {
  const c = $("#insMap"), { ctx, w, h, dpr } = fitCanvas(c);
  const cols = I.nPre + I.nData, N = I.N;
  // Max-pool the bins into display rows so a one-bin peak never disappears
  const rows = Math.min(N, Math.max(32, Math.round(h / (2 * dpr))));
  const img = new ImageData(cols, rows);
  for (let col = 0; col < cols; col++) {
    for (let r = 0; r < rows; r++) {
      let v = 0;
      for (let k = Math.floor((r * N) / rows); k < Math.floor(((r + 1) * N) / rows); k++) v = Math.max(v, I.map[col * N + k]);
      v = Math.max(0, Math.min(255, Math.round((v - 85) * 1.5)));   // Push the noise (about +7 dB peaks) down
      const p = ((rows - 1 - r) * cols + col) * 4;
      img.data[p] = LUT[v * 3]; img.data[p + 1] = LUT[v * 3 + 1]; img.data[p + 2] = LUT[v * 3 + 2]; img.data[p + 3] = 255;
    }
  }
  const off = new OffscreenCanvas(cols, rows);
  off.getContext("2d").putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, w, h);
  const cw = w / cols, y = (k) => h - ((k + 0.5) / N) * h;
  // Preamble shading and data markers
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(0, 0, I.nPre * cw, h);
  ctx.lineWidth = 1.5 * dpr;
  for (let i = 0; i < I.nData; i++) {
    const x = (I.nPre + i + 0.5) * cw;
    if (I.expected) {
      ctx.strokeStyle = "#4ade80";
      ctx.beginPath(); ctx.arc(x, y(I.expected[i]), 4 * dpr, 0, 2 * Math.PI); ctx.stroke();
    }
    if (I.expected && I.hard[i] !== I.expected[i]) {
      ctx.fillStyle = "#f87171";
      ctx.beginPath(); ctx.arc(x, y(I.hard[i]), 3 * dpr, 0, 2 * Math.PI); ctx.fill();
    }
  }
  ctx.fillStyle = "rgba(226,232,240,0.85)";
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText("preamble", 4 * dpr, 4 * dpr);
  ctx.fillText("data", I.nPre * cw + 4 * dpr, 4 * dpr);
}

// ======================================================================= drawing
function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1, w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return { ctx: c.getContext("2d"), w, h, dpr };
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function plotFrame(ctx, w, h, dpr, f0, f1, yMin, yMax, gridStep) {
  ctx.fillStyle = cssVar("--plot");
  ctx.fillRect(0, 0, w, h);
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = "bottom";
  ctx.strokeStyle = cssVar("--plot-grid");
  ctx.fillStyle = cssVar("--plot-text");
  ctx.lineWidth = 1;
  for (let f = Math.ceil(f0 / gridStep) * gridStep; f <= f1; f += gridStep) {
    const x = Math.round(((f - f0) / (f1 - f0)) * w) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.fillText((f / 1e6).toFixed(gridStep < 1e6 ? 1 : 0), x + 4 * dpr, h - 4 * dpr);
  }
  for (let d = Math.ceil(yMin / 10) * 10; d <= yMax; d += 10) {
    const y = Math.round(h - ((d - yMin) / (yMax - yMin)) * h) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
}

function plotLine(ctx, w, h, pts, color) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * (window.devicePixelRatio || 1);
  ctx.stroke();
  ctx.lineTo(pts[pts.length - 1][0], h);
  ctx.lineTo(pts[0][0], h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, color + "55");
  g.addColorStop(1, color + "05");
  ctx.fillStyle = g;
  ctx.fill();
}

function drawBand() {
  const c = $("#bandCanvas");
  if (!c.clientWidth) return;
  const { ctx, w, h, dpr } = fitCanvas(c);
  const pts = [];
  for (const seg of S.band) {
    const n = seg.spectrum.length;
    for (let i = 0; i < n; i++) {
      const f = seg.center + ((i - n / 2) / n) * seg.fs;
      if (Math.abs(f - seg.center) <= seg.usable && f >= FM_LOW - 2e5 && f <= FM_HIGH + 2e5) pts.push([f, seg.spectrum[i]]);
    }
  }
  pts.sort((a, b) => a[0] - b[0]);
  const vals = pts.map((p) => p[1]).sort((a, b) => a - b);
  const yMin = vals.length ? vals[Math.floor(vals.length * 0.05)] - 4 : -100;
  const yMax = vals.length ? vals[vals.length - 1] + 6 : -40;
  const f0 = FM_LOW - 2e5, f1 = FM_HIGH + 2e5;
  plotFrame(ctx, w, h, dpr, f0, f1, yMin, yMax, 2e6);
  if (pts.length > 1) {
    const step = Math.max(1, Math.floor(pts.length / (w * 1.5)));
    const xy = [];
    for (let i = 0; i < pts.length; i += step) {
      let m = -Infinity;
      for (let j = i; j < Math.min(pts.length, i + step); j++) m = Math.max(m, pts[j][1]);
      xy.push([((pts[i][0] - f0) / (f1 - f0)) * w, h - ((m - yMin) / (yMax - yMin)) * h]);
    }
    plotLine(ctx, w, h, xy, "#a5b4fc");
  }
  ctx.textBaseline = "top";
  ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
  for (const s of S.stations) {
    const x = ((s.freq - f0) / (f1 - f0)) * w;
    ctx.fillStyle = S.tags.get(s.freq)?.state === "heard" ? "#4ade80" : "#e2e8f0";
    ctx.fillText(mhz(s.freq), x - 12 * dpr, 4 * dpr);
  }
}

function drawSpectrum(m) {
  const L = S.listen, c = $("#specCanvas");
  if (!c.clientWidth) return;
  const n = m.spectrum.length;
  if (!L.spec || L.spec.length !== n) L.spec = Float32Array.from(m.spectrum);
  else for (let i = 0; i < n; i++) L.spec[i] = 0.6 * L.spec[i] + 0.4 * m.spectrum[i];
  const sorted = Float32Array.from(L.spec).sort();
  L.yMin = 0.9 * L.yMin + 0.1 * (sorted[Math.floor(n * 0.1)] - 6);
  L.yMax = 0.9 * L.yMax + 0.1 * (sorted[n - 1] + 6);
  const { ctx, w, h, dpr } = fitCanvas(c);
  const f0 = m.centerHz - m.fs / 2, f1 = m.centerHz + m.fs / 2;
  plotFrame(ctx, w, h, dpr, f0, f1, L.yMin, L.yMax, m.fs > 4e6 ? 1e6 : 5e5);
  const accent = cssVar("--accent"), helper = cssVar("--helper");
  ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  for (const s of activeStations()) {
    const x0 = ((s.freq - 100e3 - f0) / (f1 - f0)) * w, x1 = ((s.freq + 100e3 - f0) / (f1 - f0)) * w;
    const col = s === L.main ? accent : helper;
    ctx.fillStyle = col + "33";
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.fillStyle = col;
    ctx.fillRect(x0, 0, x1 - x0, 3 * dpr);
    ctx.fillText(mhz(s.freq), x0, 7 * dpr);
    const nm = stationName(s.freq);
    if (nm) { ctx.globalAlpha = 0.8; ctx.fillText(nm, x0, 21 * dpr); ctx.globalAlpha = 1; }
  }
  const xy = [];
  for (let i = 0; i < n; i++) xy.push([(i / (n - 1)) * w, h - ((L.spec[i] - L.yMin) / (L.yMax - L.yMin)) * h]);
  plotLine(ctx, w, h, xy, "#c7d2fe");
}

/** SNR of recent frames: green dots decoded, grey not. */
function drawSpark() {
  const c = $("#snrSpark"), L = S.listen;
  if (!c.clientWidth || !L) return;
  const { ctx, w, h, dpr } = fitCanvas(c);
  ctx.clearRect(0, 0, w, h);
  const v = L.snrs;
  if (!v.length) return;
  const lo = Math.min(-25, ...v.map((p) => p.snr)) - 1, hi = Math.max(5, ...v.map((p) => p.snr)) + 1;
  const x = (i) => (v.length === 1 ? w / 2 : 4 * dpr + (i / (v.length - 1)) * (w - 8 * dpr));
  const y = (s) => h - 3 * dpr - ((s - lo) / (hi - lo)) * (h - 6 * dpr);
  ctx.strokeStyle = cssVar("--border");
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  v.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.snr)) : ctx.moveTo(x(i), y(p.snr))));
  ctx.stroke();
  v.forEach((p, i) => {
    ctx.fillStyle = p.ok ? cssVar("--ok") : cssVar("--muted");
    ctx.beginPath(); ctx.arc(x(i), y(p.snr), 2.5 * dpr, 0, 2 * Math.PI); ctx.fill();
  });
}

// Perceptual colour map (dark blue -> violet -> orange -> yellow)
const LUT = (() => {
  const stops = [[0, [7, 10, 20]], [0.25, [40, 30, 110]], [0.5, [140, 40, 140]], [0.75, [235, 100, 70]], [1, [252, 230, 120]]];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [ta, ca] = stops[k], [tb, cb] = stops[k + 1], u = (t - ta) / (tb - ta);
    for (let j = 0; j < 3; j++) lut[i * 3 + j] = ca[j] + (cb[j] - ca[j]) * u;
  }
  return lut;
})();

function clearChirps() {
  const c = $("#chirpCanvas"), ctx = c.getContext("2d");
  ctx.fillStyle = "#070a14";
  ctx.fillRect(0, 0, c.width, c.height);
}

function drawChirps(wf, bins) {
  const cols = wf.length / bins;
  if (!cols) return;
  const L = S.listen, c = $("#chirpCanvas"), ctx = c.getContext("2d");
  if (c.height !== bins) { c.height = bins; clearChirps(); }
  for (let k = 0; k < cols; k++) {   // Noise floor from the column medians, smoothed
    const col = Array.from(wf.subarray(k * bins, (k + 1) * bins)).sort((a, b) => a - b);
    const med = col[bins >> 1];
    L.nf = L.nf === null ? med : 0.995 * L.nf + 0.005 * med;
  }
  const lo = L.nf + 0.5, span = 11;
  ctx.drawImage(c, -cols, 0);
  const img = ctx.createImageData(cols, bins);
  for (let k = 0; k < cols; k++) {
    for (let b = 0; b < bins; b++) {
      const v = Math.max(0, Math.min(255, Math.round(((wf[k * bins + b] - lo) / span) * 255)));
      const p = ((bins - 1 - b) * cols + k) * 4;
      img.data[p] = LUT[v * 3];
      img.data[p + 1] = LUT[v * 3 + 1];
      img.data[p + 2] = LUT[v * 3 + 2];
      img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, c.width - cols, 0);
}

window.addEventListener("resize", () => {
  if (S.view === "scan") drawBand();
  if (S.view === "listen") drawSpark();
});

// ======================================================================= settings drawer
function openSettings() {
  fillSettings();
  $("#settings").hidden = false;
  $("#scrim").hidden = false;
}

function closeSettings() {
  $("#settings").hidden = true;
  $("#scrim").hidden = true;
}

function fillRateSelect() {
  const sel = $("#setRate");
  sel.replaceChildren(...S.rates.map((r) => {
    const o = el("option", "", `${(r / 1e6).toFixed(r % 1e6 ? 1 : 0)} MHz`);
    o.value = String(r);
    return o;
  }));
  sel.value = String(S.fs);
}

function fillSettings() {
  const s = S.set;
  fillRateSelect();
  $("#setAuto").checked = s.auto;
  $("#setDeemph").value = String(s.deemph);
  $("#setAgc").checked = s.agc;
  $("#setGain").value = s.gain;
  $("#gainOut").textContent = `${s.gain} of 21`;
  $("#gainRow").hidden = s.agc;
  $("#setSf").value = String(s.sf);
  $("#setBw").value = String(s.bw);
  $("#setSub").value = s.subcarrier;
  $("#setLen").value = s.msgLen;
  $("#setPeriod").value = s.txPeriod;
  $("#setDown").value = s.nDown;
  $("#setUp").value = s.nUp;
  $("#setHelpers").value = s.helpers;
  $("#setCombine").value = s.combine;
  $("#setAwgnOn").checked = s.awgnOn;
  $("#setAwgn").value = s.awgnSnr;
  $("#awgnOut").textContent = `${s.awgnSnr.toFixed(1)} dB`;
  frameInfo();
}

function frameInfo() {
  const s = S.set, L = frameLayout(tagCfg()), p = $("#frameInfo");
  const lo = s.subcarrier - s.bw / 2000, hi = s.subcarrier + s.bw / 2000;
  const ok = L.seconds + 0.3 < s.txPeriod;
  const wide = channelRateFor(s.subcarrier * 1000, s.bw) > 250000;
  p.textContent = `Tag chirps sweep ${lo.toFixed(1)}–${hi.toFixed(1)} kHz. One frame is ${L.chirps} chirps = ${L.seconds.toFixed(2)} s` +
    (ok ? `, sent every ${s.txPeriod} s.` : `, longer than the ${s.txPeriod} s period: raise the period.`) +
    (wide ? " Above the stereo band: the receiver uses a 500 kHz channel." : "");
  p.className = ok ? "info" : "info bad";
}

let restartTimer;
function changed(key, value, how) {
  S.set[key] = value;
  save(STORE, S.set);
  fillSettings();
  if (how === "gain") applyGain().catch((e) => toast(explain(e)));
  if (how === "awgn") {
    updateAwgnBadge();
    worker.postMessage({ type: "awgn", snr: awgnValue() });
  }
  if (how === "restart" && S.listen) {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => (key === "helpers" ? listenTo(S.listen.main) : startListen()), 400);
  }
}

async function changeRate(rate) {
  S.set.rate = rate;
  save(STORE, S.set);
  if (rate === S.fs) return;
  S.fs = rate;
  S.abortFind = true;
  if (S.dev) {
    try {
      await S.dev.stop();
      await S.dev.setSampleRate(rate);
      worker.postMessage({ type: "reset", fs: rate, format: S.dev.format });
      await startStream();
    } catch (e) {
      toast(explain(e));
      return;
    }
  } else if (S.demo) {
    worker.postMessage({ type: "reset", fs: rate });
    worker.postMessage({ type: "demo", fs: rate });
  } else return;
  closeSettings();
  toast(`Bandwidth set to ${rate / 1e6} MHz. Scanning again…`);
  show("scan");
  scan();
}

/** The tag's I2S bit rate: 400 kHz inside the stereo band, 2 MHz above it (a cleaner square wave). */
function tagSampleRate(hi, bw) {
  for (const r of hi <= 60000 ? [400000, 800000, 2000000] : [2000000, 4000000]) if (r % (bw * 8) === 0) return r;
  return 2000000;
}

function firmwareSnippet() {
  const s = S.set, lo = Math.round(s.subcarrier * 1000 - s.bw / 2), hi = Math.round(s.subcarrier * 1000 + s.bw / 2);
  const defs = { MSG_LEN: s.msgLen, SYSTEM_CYCLE_TIME_MS: Math.round(s.txPeriod * 1000), F_START: lo, F_END: hi,
    SAMPLE_RATE: tagSampleRate(hi, s.bw), SPREADING_FACTOR: s.sf, PREAMBLE_DOWNCHIRPS: s.nDown, PREAMBLE_UPCHIRPS: s.nUp };
  return [
    "// Either paste over the matching #defines in MyosaBoard/main/main.c:",
    ...Object.entries(defs).map(([k, v]) => `#define ${k.padEnd(20)} ${v}`),
    "",
    "// or build without editing main.c (from MyosaBoard/):",
    `// idf.py -DLORAB_DEFS="${Object.entries(defs).map(([k, v]) => `${k}=${v}`).join(";")}" build flash`,
  ].join("\n");
}

async function copyFirmware() {
  const text = firmwareSnippet();
  try {
    await navigator.clipboard.writeText(text);
    toast("Firmware settings copied. Paste them into MyosaBoard/main/main.c.");
  } catch {
    window.prompt("Copy these lines into MyosaBoard/main/main.c:", text);
  }
}

function bindSettings() {
  const num = (id, key, lo, hi, how = "restart", int = true) => $(id).addEventListener("change", (e) => {
    let v = Number(e.target.value);
    if (!Number.isFinite(v)) return fillSettings();
    v = Math.max(lo, Math.min(hi, int ? Math.round(v) : v));
    changed(key, v, how);
  });
  $("#setRate").addEventListener("change", (e) => changeRate(Number(e.target.value)));
  $("#setAuto").addEventListener("change", (e) => changed("auto", e.target.checked));
  $("#setDeemph").addEventListener("change", (e) => {
    changed("deemph", Number(e.target.value));
    if (S.audio.on) worker.postMessage({ type: "audio", on: true, deemph: S.set.deemph * 1e-6 });
  });
  $("#setAgc").addEventListener("change", (e) => changed("agc", e.target.checked, "gain"));
  $("#setGain").addEventListener("input", (e) => changed("gain", Number(e.target.value), "gain"));
  $("#setSf").addEventListener("change", (e) => changed("sf", Number(e.target.value), "restart"));
  $("#setBw").addEventListener("change", (e) => changed("bw", Number(e.target.value), "restart"));
  num("#setSub", "subcarrier", 5, 200, "restart", false);
  num("#setLen", "msgLen", 1, 64);
  num("#setPeriod", "txPeriod", 1, 120, "restart", false);
  num("#setDown", "nDown", 4, 16);
  num("#setUp", "nUp", 1, 8);
  num("#setHelpers", "helpers", 0, 6);
  num("#setCombine", "combine", 1, 8);
  $("#setAwgnOn").addEventListener("change", (e) => changed("awgnOn", e.target.checked, "awgn"));
  $("#setAwgn").addEventListener("input", (e) => {
    $("#awgnOut").textContent = `${Number(e.target.value).toFixed(1)} dB`;
  });
  $("#setAwgn").addEventListener("change", (e) => changed("awgnSnr", Number(e.target.value), "awgn"));
  $("#copyFwBtn").addEventListener("click", copyFirmware);
  $("#resetBtn").addEventListener("click", () => {
    const rate = S.set.rate;
    S.set = { ...DEFAULTS, rate };
    save(STORE, S.set);
    fillSettings();
    updateAwgnBadge();
    applyGain().catch(() => {});
    worker.postMessage({ type: "awgn", snr: awgnValue() });
    if (S.listen) listenTo(S.listen.main);
  });
  $("#disconnectBtn").addEventListener("click", disconnect);
}

// ======================================================================= start
$("#connectBtn").addEventListener("click", (e) => connect(e.target.dataset.paired === "1"));
$("#demoBtn").addEventListener("click", startDemo);
$("#scanBtn").addEventListener("click", scan);
$("#findBtn").addEventListener("click", findTag);
$("#bestBtn").addEventListener("click", () => { const b = bestTagStation(); if (b) listenTo(b); });
$("#changeBtn").addEventListener("click", () => {
  worker.postMessage({ type: "stop" });
  S.listen = null;
  show("scan");
  renderStationGrid();
});
$("#csvBtn").addEventListener("click", exportCsv);
$("#audioBtn").addEventListener("click", toggleAudio);
$("#volume").addEventListener("input", (e) => { if (S.audio.gain) S.audio.gain.gain.value = Number(e.target.value); });
$("#tuneForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = Math.round(Number($("#tuneFreq").value) * 20) * 5e4;   // 50 kHz raster
  if (!(f >= FM_LOW && f <= FM_HIGH)) { toast("Enter a frequency between 87.5 and 108 MHz."); return; }
  listenTo(S.stations.find((s) => s.freq === f) || { freq: f, snr: 0, power: 0 });
});
$("#insClose").addEventListener("click", () => $("#inspector").close());
$("#inspector").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$("#settingsBtn").addEventListener("click", openSettings);
$("#closeSettings").addEventListener("click", closeSettings);
$("#scrim").addEventListener("click", closeSettings);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSettings(); });
bindSettings();
fillSettings();
show("connect");

if ("usb" in navigator) {
  refreshConnectButton();
  navigator.usb.addEventListener("disconnect", (e) => { if (S.dev && e.device === S.dev.dev) onDeviceLost(); });
  // Plug and play: a radio this site may already use starts by itself
  navigator.usb.addEventListener("connect", (e) => { if (!S.dev && !S.demo && isRadio(e.device)) connect(true); });
  pairedRadio().then((d) => { if (d && !S.dev && !S.demo) connect(true); }).catch(() => {});
} else {
  showConnectError(window.isSecureContext
    ? "This browser can't talk to USB devices. Use Chrome, Edge or Opera to connect a radio, or try the demo."
    : "USB needs a secure page. Open this site over https:// or http://localhost, or try the demo.");
}

// Installable, and the demo works offline
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
