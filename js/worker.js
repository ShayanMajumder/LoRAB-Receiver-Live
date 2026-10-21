// Radio worker: Airspy raw samples in; scan results, spectrum, chirp
// waterfall, station names and decoded frames out.
//
// IQ conversion, scanning and the frame decoder run here. Each station's
// demodulation runs in a station worker (station-core.js); the main thread
// hands us one port per station worker ("pool"), so stations decode in
// parallel on separate cores.

import { AirspyIQ, PowerSpectrum, findStations, LorabReceiver, FFT, frameLayout, AWGN_OFF } from "./dsp.js";
import { demoSpectrum } from "./demo.js";

const WF_BINS = 64;            // Chirp waterfall FFT size
const POST_MS = 100;           // Display update interval
const MAX_INFLIGHT = 40;       // IQ blocks out at the station workers before we drop
const DEMO_TICK_MS = 50;

let fs = 3e6;
let iq = new AirspyIQ();
let scan = null;
let listen = null;
let demo = false;
let ports = [];
let seq = 0;
const load = { busy: 0, stations: 0, start: performance.now(), raw: 0, dropped: 0 };

const post = (msg, transfer) => postMessage(msg, transfer || []);

onmessage = ({ data: m }) => {
  try {
    switch (m.type) {
      case "pool":
        ports = m.ports;
        ports.forEach((p) => (p.onmessage = ({ data }) => onStation(data)));
        break;
      case "reset":
        fs = m.fs;
        iq = new AirspyIQ();
        scan = null;
        stopListen();
        demo = false;
        break;
      case "demo":
        demo = true;
        fs = m.fs;
        break;
      case "raw":
        onRaw(new Uint16Array(m.buf));
        break;
      case "scanStep":
        scan = { centerHz: m.centerHz, skip: m.skip, take: m.take, usable: m.usable, ps: new PowerSpectrum(4096) };
        if (demo) demoScanStep();
        break;
      case "listen":
        startListen(m);
        break;
      case "awgn":
        listen?.rx.setAwgn(m.snr);
        break;
      case "audio":                        // Station 0 (the main one) is always on worker 0
        if (listen) {
          listen.audio = m.on;
          listen.used[0].postMessage({ type: "audio", on: m.on, deemph: m.deemph });
        }
        break;
      case "stop":
        scan = null;
        stopListen();
        break;
    }
  } catch (e) {
    post({ type: "error", message: e.message });
  }
};

function onRaw(raw) {
  const t0 = performance.now();
  load.raw++;
  const x = iq.process(raw);
  if (scan) scanBlock(x);
  else if (listen) {
    listen.spec.add(x, 2);
    sendBlock({ type: "iq", iq: x }, x.buffer);
  }
  load.busy += performance.now() - t0;
  report();
}

/** Sends one block (IQ, or a demo tick) to every station worker in use. */
function sendBlock(msg, buffer) {
  const L = listen;
  if (L.pending.size >= MAX_INFLIGHT) { load.dropped++; return; }
  const s = seq++;
  L.pending.set(s, { outs: new Array(L.n), got: 0 });
  L.used.forEach((p, i) => {
    const last = i === L.used.length - 1;
    p.postMessage({ ...msg, seq: s }, last && buffer ? [buffer] : []);
  });
}

function report() {
  const now = performance.now(), wall = now - load.start;
  if (wall < 1000) return;
  post({ type: "load", load: load.busy / wall, stations: load.stations / wall,
    threads: 1 + (listen?.used.length || 0), processed: load.raw, dropped: load.dropped });
  Object.assign(load, { busy: 0, stations: 0, start: now, raw: 0, dropped: 0 });
}

// ----------------------------------------------------------------- scan
function scanBlock(x) {
  const n = x.length / 2;
  if (scan.skip > 0) { scan.skip -= n; return; }
  scan.ps.add(x, 16);
  scan.take -= n;
  if (scan.take > 0) return;
  const spec = scan.ps.take();
  post({ type: "scanResult", centerHz: scan.centerHz, stations: findStations(spec, fs, scan.centerHz, scan.usable), spectrum: spec, fs });
  scan = null;
}

function demoScanStep() {
  const c = scan.centerHz, spec = demoSpectrum(c, fs, 4096);
  const stations = findStations(spec, fs, c, scan.usable);
  scan = null;
  setTimeout(() => post({ type: "scanResult", centerHz: c, stations, spectrum: spec, fs }), 350);
}

// ----------------------------------------------------------------- listen
function startListen(m) {
  scan = null;
  stopListen();
  if (!ports.length) throw new Error("No station workers");
  const cfg = m.cfg, n = m.stations.length, used = ports.slice(0, Math.min(n, ports.length));
  const labels = m.stations.map((s) => (s.freq / 1e6).toFixed(1));
  listen = {
    centerHz: m.centerHz, cfg, n, used,
    pending: new Map(), nextSeq: seq,
    spec: new PowerSpectrum(2048),
    wf: { buf: new Float32Array(0), cols: [] },
    lastPost: performance.now(),
    timer: null,
    audio: !!m.audio,
  };
  listen.rx = new LorabReceiver(cfg, labels, {
    onFrame: (ev) => post({ type: "frame", ev }),
    onLog: (text) => post({ type: "log", text }),
  });
  listen.rx.setAwgn(m.awgn ?? AWGN_OFF);
  // Stations go round-robin to the workers
  const demoOffset = demo ? Math.floor(Math.random() * 1e9) : undefined;
  used.forEach((p, w) => p.postMessage({
    type: "start", fs, centerHz: m.centerHz, cfg, demoOffset, audio: m.audio, deemph: m.deemph,
    stations: m.stations.map((s, idx) => ({ idx, freq: s.freq })).filter((s) => s.idx % used.length === w),
  }));
  if (demo) {
    const n = Math.round(((cfg.chanRate || 250000) * DEMO_TICK_MS) / 1000);
    listen.timer = setInterval(() => listen && sendBlock({ type: "tick", n }), DEMO_TICK_MS);
  }
  post({ type: "log", text: `Listening: ${labels.join(", ")} MHz on ${used.length} thread(s), frame ${frameLayout(cfg).seconds.toFixed(2)} s` });
}

function stopListen() {
  if (!listen) return;
  clearInterval(listen.timer);
  listen.used.forEach((p) => p.postMessage({ type: "stop" }));
  listen = null;
}

function onStation(m) {
  if (m.type === "rds") { post({ type: "rds", freq: m.freq, ps: m.ps, pi: m.pi }); return; }
  if (m.type === "audio") { if (listen?.audio) post({ type: "audio", pcm: m.pcm }, [m.pcm.buffer]); return; }
  if (m.type !== "bb") return;
  load.stations += m.busy;
  const L = listen, p = L?.pending.get(m.seq);
  if (!p) return;                                  // From a previous session
  for (const o of m.outs) p.outs[o.idx] = o.bb;
  p.got += m.outs.length;
  // Deliver complete blocks in order
  const t0 = performance.now();
  for (let q = L.pending.get(L.nextSeq); q && q.got === L.n; q = L.pending.get(L.nextSeq)) {
    L.pending.delete(L.nextSeq++);
    L.rx.push(q.outs);
    waterfall(q.outs[0]);
  }
  load.busy += performance.now() - t0;
  const now = performance.now();
  if (now - L.lastPost >= POST_MS) {
    L.lastPost = now;
    const spectrum = demo ? demoSpectrum(L.centerHz, fs, 2048) : L.spec.take();
    const cols = L.wf.cols.splice(0), wf = new Float32Array(cols.length * WF_BINS);
    cols.forEach((c, i) => wf.set(c, i * WF_BINS));
    post({ type: "display", spectrum, fs, centerHz: L.centerHz, wf, wfBins: WF_BINS,
      locked: L.rx.locked, decoded: L.rx.decoded, seen: L.rx.frames }, [spectrum.buffer, wf.buffer]);
  }
  if (demo) report();
}

/**
 * One waterfall column every WF_BINS / 2 baseband samples (fft-shifted, dB):
 * the average of three half-overlapped windows, lightly smoothed across
 * frequency, so chirps stand out from the noise speckle.
 */
function waterfall(b) {
  const W = listen.wf, n = WF_BINS, hop = n / 2;
  const buf = new Float32Array(W.buf.length + b.length);
  buf.set(W.buf);
  buf.set(b, W.buf.length);
  const f = FFT.of(n), re = new Float64Array(n), im = new Float64Array(n), pw = new Float64Array(n);
  let o = 0;
  for (; o + 2 * (n + hop * 2) <= buf.length; o += 2 * hop) {
    pw.fill(0);
    for (let w = 0; w < 3; w++) {
      const s = o + 2 * hop * w;
      for (let i = 0; i < n; i++) {
        const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
        re[i] = buf[s + 2 * i] * win;
        im[i] = buf[s + 2 * i + 1] * win;
      }
      f.transform(re, im);
      for (let i = 0; i < n; i++) pw[i] += re[i] ** 2 + im[i] ** 2;
    }
    const col = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = (i + n / 2) % n;
      const v = 0.25 * pw[(k + n - 1) % n] + 0.5 * pw[k] + 0.25 * pw[(k + 1) % n];
      col[i] = 10 * Math.log10(v + 1e-20);
    }
    W.cols.push(col);
  }
  W.buf = buf.slice(o);
}
