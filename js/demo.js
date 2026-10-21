// Simulated radio for the demo: FM stations, some of them carrying the tag.
// Station signals are generated at the channel rate (250 or 500 kHz) and fed
// to the real receiver chain from there on.

import { CHANNEL_RATE, encodeFrame, frameLayout } from "./dsp.js";

export const DEMO_MESSAGE = "Hello from Myosa";
const MELODY = [0, 4, 7, 12, 7, 4, 2, 5, 9, 14, 9, 5];   // Semitones above middle C

export const DEMO_STATIONS = [
  { freq: 88.6e6, level: 14, name: "CLASSIC" }, { freq: 90.2e6, level: 22, name: "NEWS 24" },
  { freq: 91.3e6, level: 17, name: "JAZZ FM" },
  { freq: 92.1e6, level: 28, name: "CITY FM", tag: 0.010 },
  { freq: 92.9e6, level: 20, name: "ROCK 93", tag: 0.004 },
  { freq: 93.6e6, level: 24, name: "CAMPUS", tag: 0.006, mono: true },
  { freq: 96.4e6, level: 19, name: "HITS" }, { freq: 99.5e6, level: 26, name: "RADIO 1" },
  { freq: 101.1e6, level: 15, name: "TALK" }, { freq: 104.6e6, level: 21, name: "DANCE" },
];

export const demoStation = (freq) => DEMO_STATIONS.find((s) => Math.abs(s.freq - freq) < 50e3);

/** Power spectrum (dB, fft-shifted, n bins) of the simulated band around centerHz. */
export function demoSpectrum(centerHz, fs, n) {
  const spec = new Float32Array(n);
  for (let i = 0; i < n; i++) spec[i] = -95 + 2 * Math.random();
  for (const s of DEMO_STATIONS) {
    const k0 = ((s.freq - centerHz) / fs) * n + n / 2, w = Math.ceil((150e3 / fs) * n);
    for (let i = Math.max(0, Math.floor(k0 - w)); i < Math.min(n, k0 + w); i++) {
      const df = ((i - k0) * fs) / n;
      spec[i] = Math.max(spec[i], -95 + s.level * Math.exp(-((df / 90e3) ** 4)) + Math.random());
    }
  }
  return spec;
}

/**
 * One station's channel samples (interleaved complex at 250 kHz). Every
 * station of a session uses the same frame clock (offset), so frames line up.
 */
export class DemoChannel {
  constructor(freq, cfg, offset) {
    const d = demoStation(freq) || {};
    this.tag = d.tag ?? 0.0015;
    this.mono = !!d.mono;
    this.cfg = cfg;
    this.rate = cfg.chanRate || CHANNEL_RATE;
    this.L = frameLayout(cfg);
    this.symbols = encodeFrame(DEMO_MESSAGE, cfg);
    this.chip = this.rate / cfg.bw;
    this.period = cfg.txPeriod * this.rate;
    this.n = offset % this.period;
    this.fm = 0;
    this.tagPh = 0;
    this.pilot = 0;
    this.lp = [0, 0];
    this.notePh = 0;
    this.key = (Math.round(freq / 1e5) % 5);       // Each station plays in its own key
  }

  next(count) {
    const { cfg, L, symbols, chip, period, rate } = this, z = new Float32Array(2 * count);
    const frameSamples = L.frameLen * chip, noteLen = Math.round(0.3 * rate);
    for (let i = 0; i < count; i++, this.n++) {
      // Programme audio: a soft melody plus low-passed noise with a little stereo difference
      const k = Math.floor(this.n / noteLen), env = Math.sin((Math.PI * (this.n % noteLen)) / noteLen);
      this.notePh += (2 * Math.PI * 261.6 * 2 ** (MELODY[(k + this.key) % MELODY.length] / 12)) / rate;
      const music = 0.3 * env * Math.sin(this.notePh);
      this.lp[0] += 0.05 * (Math.random() - 0.5 - this.lp[0]);
      this.lp[1] += 0.05 * (Math.random() - 0.5 - this.lp[1]);
      const l = music + 0.6 * this.lp[0], r = music + 0.6 * this.lp[1];
      this.pilot += (2 * Math.PI * 19000) / rate;
      let mpx = 0.45 * (l + r);
      if (!this.mono) mpx += 0.09 * Math.cos(this.pilot) + 0.45 * (l - r) * Math.cos(2 * this.pilot);
      const u = this.n % period;
      if (u < frameSamples) {
        const c = Math.floor(u / (L.N * chip)), w = (u / chip) % L.N;
        let f;
        if (c < cfg.nDown) f = cfg.bw / 2 - (cfg.bw * w) / L.N;
        else {
          const s = c < L.nPre ? 0 : symbols[c - L.nPre];
          f = -cfg.bw / 2 + (cfg.bw * ((w + s) % L.N)) / L.N;
        }
        this.tagPh += (2 * Math.PI * (cfg.subcarrier + f)) / rate;
        mpx += this.tag * Math.cos(this.tagPh);
      }
      this.fm += (2 * Math.PI * 75e3 * mpx) / rate;
      z[2 * i] = Math.cos(this.fm) + 0.03 * (Math.random() - 0.5);
      z[2 * i + 1] = Math.sin(this.fm) + 0.03 * (Math.random() - 0.5);
    }
    this.fm %= 2 * Math.PI;                  // Keep the phases small for precision
    this.tagPh %= 2 * Math.PI;
    this.pilot %= 2 * Math.PI;
    this.notePh %= 2 * Math.PI;
    return z;
  }
}
