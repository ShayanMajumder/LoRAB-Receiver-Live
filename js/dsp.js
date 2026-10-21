// DSP for the LoRAB web receiver.
//
//   Airspy raw samples -> IQ (port of libairspy iqconverter_float)
//   IQ -> one FM station (mix + 2-stage decimation to 250 kHz) -> FM demod (MPX)
//   MPX -> tag subcarrier (43..53 kHz) mixed to 0 Hz -> complex baseband at the
//          chirp bandwidth, one sample per chip
//   Baseband of every station -> LorabReceiver: preamble search, noncoherent
//          soft demod, soft Viterbi, CRC, soft combining across stations and
//          across repeated frames.
//
// The frame format matches MyosaBoard/main/main.c and lorab_text_rx.py.

// ===================================================================== FFT
const fftCache = new Map();

export class FFT {
  static of(n) {
    let f = fftCache.get(n);
    if (!f) fftCache.set(n, (f = new FFT(n)));
    return f;
  }

  constructor(n) {
    const bits = Math.log2(n);
    if (!Number.isInteger(bits)) throw new Error(`FFT size ${n} is not a power of 2`);
    this.n = n;
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0, v = i; b < bits; b++, v >>= 1) r = (r << 1) | (v & 1);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }

  /** In place. Forward uses e^{-j}, inverse e^{+j} without 1/n scaling. */
  transform(re, im, inverse = false) {
    const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sg = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const c = cs[k], s = sg * sn[k], l = j + half;
          const tr = re[l] * c - im[l] * s, ti = re[l] * s + im[l] * c;
          re[l] = re[j] - tr; im[l] = im[j] - ti;
          re[j] += tr; im[j] += ti;
        }
      }
    }
  }
}

export function nextPow2(n) {
  return 1 << Math.ceil(Math.log2(Math.max(1, n)));
}

// ===================================================================== filters
function besselI0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 60; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

/** Kaiser-window low-pass, unity DC gain. cutoff = -6 dB point. */
export function kaiserLowpass(cutoff, transition, fs, attenDb = 60) {
  const A = attenDb;
  const beta = A > 50 ? 0.1102 * (A - 8.7) : A >= 21 ? 0.5842 * (A - 21) ** 0.4 + 0.07886 * (A - 21) : 0;
  let n = Math.ceil((A - 7.95) / (2.285 * ((2 * Math.PI * transition) / fs))) + 1;
  if (n % 2 === 0) n++;
  const m = (n - 1) / 2, x = (2 * cutoff) / fs, i0b = besselI0(beta);
  const taps = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = i - m;
    const sinc = t === 0 ? x : Math.sin(Math.PI * x * t) / (Math.PI * t);
    taps[i] = sinc * (besselI0(beta * Math.sqrt(Math.max(0, 1 - (t / m) ** 2))) / i0b);
    sum += taps[i];
  }
  for (let i = 0; i < n; i++) taps[i] /= sum;
  return taps;
}

/**
 * Streaming decimating FIR for interleaved complex Float32 samples, with
 * linear-phase (symmetric, odd-length) taps. An optional Mixer is applied
 * while the input is loaded, so mixing costs no extra pass. The returned
 * array is reused by the next call.
 */
export class Decimator {
  constructor(taps, D) {
    this.h = Float64Array.from(taps);
    this.D = D;
    this.hl = 2 * (taps.length - 1);
    this.w = new Float32Array(this.hl);
    this.y = new Float32Array(0);
    this.phase = 0;
  }

  process(x, mixer) {
    const h = this.h, L = h.length, D = this.D, hl = this.hl, nIn = x.length >> 1;
    if (this.w.length < hl + x.length) {
      const w = new Float32Array(hl + x.length);
      w.set(this.w.subarray(0, hl));
      this.w = w;
    }
    const w = this.w;
    if (mixer) mixer.mixInto(x, w, hl); else w.set(x, hl);
    const first = this.phase;
    const nOut = first < nIn ? Math.floor((nIn - 1 - first) / D) + 1 : 0;
    if (this.y.length < 2 * nOut) this.y = new Float32Array(2 * nOut + 64);
    const y = this.y;
    const mid = (L - 1) >> 1, hm = h[mid];   // Fold the symmetric tap pairs
    for (let k = 0; k < nOut; k++) {
      const p0 = 2 * (L - 1 + first + k * D), q0 = p0 - 2 * (L - 1);
      let re = hm * w[p0 - 2 * mid], im = hm * w[p0 - 2 * mid + 1];
      for (let t = 0, p = p0, q = q0; t < mid; t++, p -= 2, q += 2) {
        const c = h[t];
        re += c * (w[p] + w[q]);
        im += c * (w[p + 1] + w[q + 1]);
      }
      y[2 * k] = re;
      y[2 * k + 1] = im;
    }
    this.phase = first + nOut * D - nIn;
    w.copyWithin(0, x.length, x.length + hl);   // Keep the last L-1 samples
    return y.subarray(0, 2 * nOut);
  }
}

/** Multiplies interleaved complex samples by e^{-j 2 pi f n / fs}, phase continuous. */
export class Mixer {
  constructor(freq, fs) {
    const w = (2 * Math.PI * freq) / fs;
    this.dc = Math.cos(w);
    this.ds = Math.sin(w);
    this.c = 1;
    this.s = 0;
  }

  mix(x) {
    return this.mixInto(x, x, 0);
  }

  /** dst[off..] = src mixed. */
  mixInto(src, dst, off) {
    let c = this.c, s = this.s;
    const dc = this.dc, ds = this.ds, n = src.length;
    for (let i = 0; i < n; i += 2) {
      const re = src[i], im = src[i + 1];
      dst[off + i] = re * c + im * s;
      dst[off + i + 1] = im * c - re * s;
      const nc = c * dc - s * ds;
      s = s * dc + c * ds;
      c = nc;
    }
    const g = 1 / Math.sqrt(c * c + s * s);
    this.c = c * g;
    this.s = s * g;
    return dst;
  }
}

/** atan2 with a polynomial, max error about 1e-5 rad. */
export function fastAtan2(y, x) {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (ax === 0 && ay === 0) return 0;
  const z = ax > ay ? ay / ax : ax / ay, z2 = z * z;
  let r = z * (0.9998660 + z2 * (-0.3302995 + z2 * (0.1801410 + z2 * (-0.0851330 + z2 * 0.0208351))));
  if (ay > ax) r = 1.5707963267948966 - r;
  if (x < 0) r = 3.141592653589793 - r;
  return y < 0 ? -r : r;
}

// ===================================================================== Airspy IQ
// libairspy HB_KERNEL_FLOAT (47 taps); its even taps run on the I branch and
// the centre tap (0.5) scales the Q branch, delayed by 12 samples.
const HB = Float64Array.from([-0.000998606272947510, 0.001695637278417295, -0.003054430179754289,
  0.005055504379767936, -0.007901319195893647, 0.011873357051047719, -0.017411159379930066,
  0.025304817427568772, -0.037225225204559217, 0.057533286997004301, -0.102327462004259350,
  0.317034472508947400, 0.317034472508947400, -0.102327462004259350, 0.057533286997004301,
  -0.037225225204559217, 0.025304817427568772, -0.017411159379930066, 0.011873357051047719,
  -0.007901319195893647, 0.005055504379767936, -0.003054430179754289, 0.001695637278417295,
  -0.000998606272947510]);
const HB_CENTER = 0.5;
const Q_DELAY = HB.length >> 1;     // 12

/** Raw Airspy uint16 real samples (2 x fs) -> interleaved complex at fs (new array each call). */
export class AirspyIQ {
  constructor() {
    this.avg = 0;
    this.e = new Float32Array(HB.length - 1);   // I branch with L-1 samples of history
    this.q = new Float32Array(Q_DELAY);          // Q branch with its 12-sample delay
    this.n = 0;                                  // Real samples processed (fs/4 sign pattern)
  }

  process(raw) {
    const len = raw.length & ~1, half = len >> 1, hl = HB.length - 1;
    const out = new Float32Array(len);
    if (this.e.length < hl + half) {
      const e = new Float32Array(hl + half);
      e.set(this.e.subarray(0, hl));
      this.e = e;
    }
    if (this.q.length < Q_DELAY + half) {
      const q = new Float32Array(Q_DELAY + half);
      q.set(this.q.subarray(0, Q_DELAY));
      this.q = q;
    }
    const e = this.e, q = this.q, k = 1 / 2048;
    let avg = this.avg, sg = (this.n & 2) ? 1 : -1;   // translate_fs_4: -, +, -, + on each branch
    for (let i = 0, m = 0; i < len; i += 2, m++, sg = -sg) {
      let a = (raw[i] - 2048) * k - avg;
      avg += 0.01 * a;
      let b = (raw[i + 1] - 2048) * k - avg;
      avg += 0.01 * b;
      e[hl + m] = sg * a;
      q[Q_DELAY + m] = sg * b * HB_CENTER;
    }
    for (let m = 0; m < half; m++) {
      let acc = 0;
      for (let t = 0, a = hl + m, b = m; t < 12; t++, a--, b++) acc += HB[t] * (e[a] + e[b]);
      out[2 * m] = acc;
      out[2 * m + 1] = q[m];
    }
    e.copyWithin(0, half, half + hl);
    q.copyWithin(0, half, half + Q_DELAY);
    this.avg = avg;
    this.n += len;
    return out;
  }
}

/** RTL-SDR uint8 I/Q pairs to interleaved float IQ, with the ADC's DC offset removed. */
export class RtlIQ {
  constructor() {
    this.dc = [0, 0];
  }

  process(raw) {
    const len = raw.length & ~1, out = new Float32Array(len), k = 1 / 127.5;
    let di = this.dc[0], dq = this.dc[1], si = 0, sq = 0;
    for (let i = 0; i < len; i += 2) {
      const a = (raw[i] - 127.5) * k, b = (raw[i + 1] - 127.5) * k;
      si += a;
      sq += b;
      out[i] = a - di;
      out[i + 1] = b - dq;
    }
    // Block mean, smoothed across blocks (one block is 65 ms at 2 MS/s)
    const n = len >> 1 || 1;
    this.dc = [di + 0.3 * (si / n - di), dq + 0.3 * (sq / n - dq)];
    return out;
  }
}

// ===================================================================== spectrum
/** Averaged, fft-shifted power spectrum (dB) of interleaved complex samples. */
export class PowerSpectrum {
  constructor(nfft = 2048) {
    this.nfft = nfft;
    this.win = new Float32Array(nfft);
    let wsum = 0;
    for (let i = 0; i < nfft; i++) {
      this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nfft);
      wsum += this.win[i] ** 2;
    }
    this.norm = 1 / (wsum * nfft);
    this.acc = new Float64Array(nfft);
    this.count = 0;
    this.re = new Float64Array(nfft);
    this.im = new Float64Array(nfft);
  }

  add(x, maxFrames = 8) {
    const n = this.nfft, f = FFT.of(n);
    const frames = Math.min(maxFrames, Math.floor(x.length / (2 * n)));
    const stride = frames > 1 ? Math.floor((x.length / 2 - n) / (frames - 1)) : 0;
    for (let k = 0; k < frames; k++) {
      const o = 2 * k * stride;
      for (let i = 0; i < n; i++) {
        this.re[i] = x[o + 2 * i] * this.win[i];
        this.im[i] = x[o + 2 * i + 1] * this.win[i];
      }
      f.transform(this.re, this.im);
      for (let i = 0; i < n; i++) this.acc[i] += this.re[i] ** 2 + this.im[i] ** 2;
      this.count++;
    }
  }

  take() {
    const n = this.nfft, out = new Float32Array(n);
    const c = Math.max(1, this.count);
    for (let i = 0; i < n; i++) {
      const v = this.acc[(i + n / 2) % n] / c;
      out[i] = 10 * Math.log10(v * this.norm * n + 1e-20);
    }
    this.acc.fill(0);
    this.count = 0;
    return out;
  }
}

/**
 * FM stations in a spectrum (dB, fft-shifted) centred on centerHz.
 * Channel power is averaged over +-60 kHz on a 50 kHz raster within
 * +-usableHz; the noise floor is the 20th percentile of those channels, so a
 * crowded window doesn't raise it. A station is a channel at least minSnr
 * above the floor and the strongest within +-100 kHz. Averaging over a
 * whole channel makes even 4-5 dB stations reliable.
 */
export function findStations(specDb, fs, centerHz, usableHz, minSnr = 4.5) {
  const n = specDb.length, binHz = fs / n, w = Math.round(60e3 / binHz);
  const lin = specDb.map((d) => 10 ** (d / 10));
  const chans = [];
  for (let f = Math.ceil((centerHz - usableHz) / 5e4) * 5e4; f <= centerHz + usableHz; f += 5e4) {
    const c = Math.round((f - centerHz) / binHz + n / 2);
    let p = 0;
    for (let i = c - w; i <= c + w; i++) p += lin[Math.min(n - 1, Math.max(0, i))];
    chans.push({ freq: Math.round(f), power: 10 * Math.log10(p / (2 * w + 1)) });
  }
  const sorted = chans.map((c) => c.power).sort((x, y) => x - y);
  const floor = sorted[Math.floor(0.2 * sorted.length)];
  return chans.filter((c, i) => c.power - floor >= minSnr &&
      chans.every((o, j) => Math.abs(j - i) > 2 || o.power <= c.power))
    .map((c) => ({ ...c, snr: c.power - floor }));
}

// ===================================================================== station chain
export const CHANNEL_RATE = 250000;

/**
 * Channel rate for a tag subcarrier: 250 kHz while the tag sits inside the
 * stereo multiplex (up to ~60 kHz), 500 kHz for a subcarrier above it. The
 * tag's sidebands reach the carrier offset + 75 kHz deviation, so a high
 * subcarrier needs the wider channel.
 */
export function channelRateFor(subcarrierHz, bw) {
  return subcarrierHz + bw / 2 > 60000 ? 500000 : CHANNEL_RATE;
}

/**
 * One FM station: wideband IQ -> channel (250 or 500 kHz) -> FM demod -> tag
 * subcarrier at 0 Hz -> complex baseband at the chirp bandwidth. Optionally
 * also the mono audio (50 kHz) and RDS.
 */
export class StationChain {
  constructor({ fs, offsetHz, bw, subcarrierHz, chanRate = CHANNEL_RATE }) {
    const R = chanRate, D = fs / R, Dbb = R / bw;
    if (!Number.isInteger(D)) throw new Error(`Sample rate ${fs} is not a multiple of ${R / 1000} kHz`);
    if (!Number.isInteger(Dbb)) throw new Error(`Chirp bandwidth ${bw} Hz must divide ${R / 1000} kHz`);
    this.rate = R;
    // Channel: mix to 0 Hz, then two decimating stages, pass +-0.44 R, stop beyond 0.56 R
    const D2 = D % 3 === 0 ? 3 : D % 5 === 0 ? 5 : D % 2 === 0 ? 2 : D;
    const D1 = D / D2, fa = fs / D1, pass = 0.44 * R, stop = 0.56 * R, stopA = fa - stop;
    this.mixer = new Mixer(offsetHz, fs);
    this.decA = D1 > 1 ? new Decimator(kaiserLowpass((pass + stopA) / 2, stopA - pass, fs, 60), D1) : null;
    this.decB = new Decimator(kaiserLowpass((pass + stop) / 2, stop - pass, fa, 60), D2);
    this.prev = [1, 0];
    // Tag subcarrier to 0 Hz, then down to one sample per chip in two stages
    this.sub = new Mixer(subcarrierHz, R);
    const D4 = [5, 4, 3, 2].find((d) => Dbb % d === 0) ?? 1, D3 = Dbb / D4, inter = R / D3;
    const passC = 0.6 * bw, stopC = inter - passC;
    this.decC = D3 > 1 ? new Decimator(kaiserLowpass((passC + stopC) / 2, stopC - passC, R, 60), D3) : null;
    this.decD = new Decimator(kaiserLowpass(bw / 2, 0.1 * bw, inter, 80), D4);
    this.mpxPower = 0;
    this.audio = null;
  }

  /** Mono audio on/off: 50 kHz samples, de-emphasis tau (s), delivered to onAudio(Float32Array). */
  setAudio(on, tau, onAudio) {
    this.audio = on ? {
      dec: new Decimator(kaiserLowpass(16750, 3500, this.rate, 60), this.rate / 50000),
      a: 1 - Math.exp(-1 / (tau * 50000)), y: 0, onAudio,
    } : null;
  }

  /** Wideband interleaved IQ at fs -> baseband at bw (reused array). */
  process(iq) {
    const a = this.decA ? this.decA.process(iq, this.mixer) : this.mixer.mix(iq.slice());
    return this.processChannel(this.decB.process(a));
  }

  /** Channel IQ -> baseband at bw (reused array). */
  processChannel(z) {
    const n = z.length >> 1;
    if (!this.mpx || this.mpx.length < 2 * n) this.mpx = new Float32Array(2 * n);
    const mpx = this.mpx.subarray(0, 2 * n);
    let pr = this.prev[0], pi = this.prev[1], pw = 0;
    const k = this.rate / (2 * Math.PI * 75e3);           // 1.0 = 75 kHz deviation
    for (let i = 0; i < n; i++) {
      const re = z[2 * i], im = z[2 * i + 1];
      const d = fastAtan2(im * pr - re * pi, re * pr + im * pi) * k;
      mpx[2 * i] = d;                                   // Real MPX as complex input
      mpx[2 * i + 1] = 0;
      pw += d * d;
      pr = re; pi = im;
    }
    this.prev[0] = pr;
    this.prev[1] = pi;
    this.mpxPower = 0.9 * this.mpxPower + 0.1 * (pw / Math.max(1, n));
    this.rds?.process(mpx, n);
    if (this.audio) this._audio(mpx);
    const c = this.decC ? this.decC.process(mpx, this.sub) : this.sub.mix(mpx.slice());
    return this.decD.process(c);
  }

  /** L+R audio: low-pass 15 kHz (removes the 19 kHz pilot), 50 kHz, de-emphasis. */
  _audio(mpx) {
    const A = this.audio, y = A.dec.process(mpx), m = y.length >> 1, out = new Float32Array(m);
    let v = A.y;
    for (let i = 0; i < m; i++) {
      v += A.a * (y[2 * i] - v);
      out[i] = v;
    }
    A.y = v;
    A.onAudio(out);
  }
}

// ===================================================================== RDS
// Station name (PS) and PI code from the 57 kHz RDS subcarrier in the MPX.
// Biphase symbols at 1187.5 bit/s, differentially encoded, so a product of
// consecutive matched-filter outputs gives the data bits without carrier
// recovery. Blocks are found with the standard offset words.
const RDS_RATE = 25000;                                   // After decimating the MPX
const RDS_BIT = RDS_RATE / 1187.5;                        // 21.05 samples per bit
const RDS_PHASES = 16;
const RDS_OFFSETS = [0x0fc, 0x198, 0x168, 0x1b4, 0x350];  // A, B, C, D, C'
const RDS_ORDER = [0, 1, 2, 3, 2];                        // Position of each offset in a group

function rdsSyndrome(data, bits) {
  let reg = 0;
  for (let i = bits; i > 0; i--) {
    reg = (reg << 1) | ((data >> (i - 1)) & 1);
    if (reg & 0x400) reg ^= 0x5b9;
  }
  for (let i = 10; i > 0; i--) {
    reg <<= 1;
    if (reg & 0x400) reg ^= 0x5b9;
  }
  return reg & 0x3ff;
}

export class RdsDecoder {
  constructor(onUpdate, rate = CHANNEL_RATE) {
    this.onUpdate = onUpdate;
    this.mixer = new Mixer(57000, rate);
    this.dec1 = new Decimator(kaiserLowpass(25000, 44000, rate, 50), rate / 50000);   // -> 50 kHz
    this.dec2 = new Decimator(kaiserLowpass(3550, 1900, 50000, 50), 2);           // -> 25 kHz, +-2.6 kHz
    this.ci = new Float64Array(1);           // Prefix sums of I and Q: ci[k] = sum of samples < base + k
    this.cq = new Float64Array(1);
    this.base = 0;
    this.next = 0;                           // Start of the next bit (sample index)
    this.energy = new Float64Array(RDS_PHASES);
    this.prev = new Float64Array(2 * RDS_PHASES);
    this.diff = new Float64Array(RDS_PHASES);
    this.reg = 0;
    this.nbits = 0;
    this.sync = false;
    this.last = null;                        // { off, at } of the last block seen while searching
    this.expect = 0;
    this.blockBits = 0;
    this.bad = 0;
    this.group = [];
    this.ps = new Array(8).fill(" ");
    this.seen = 0;
    this.pi = null;
    this.name = "";
  }

  /** mpx: interleaved complex with the real MPX in the even slots. */
  process(mpx, n) {
    const y = this.dec2.process(this.dec1.process(mpx.subarray(0, 2 * n), this.mixer));
    const m = y.length >> 1, L = this.ci.length;
    const ci = new Float64Array(L + m), cq = new Float64Array(L + m);
    ci.set(this.ci);
    cq.set(this.cq);
    for (let i = 0; i < m; i++) {
      ci[L + i] = ci[L + i - 1] + y[2 * i];
      cq[L + i] = cq[L + i - 1] + y[2 * i + 1];
    }
    const avail = this.base + ci.length - 1, b0 = this.base;
    const sum = (arr, a, b) => arr[Math.round(b) - b0] - arr[Math.round(a) - b0];
    while (this.next + 2 * RDS_BIT < avail) {
      let best = 0;
      for (let p = 0; p < RDS_PHASES; p++) {
        // Biphase matched filter: first half-bit minus second half-bit
        const t0 = this.next + (p / RDS_PHASES) * RDS_BIT, t1 = t0 + RDS_BIT / 2, t2 = t0 + RDS_BIT;
        const re = sum(ci, t0, t1) - sum(ci, t1, t2), im = sum(cq, t0, t1) - sum(cq, t1, t2);
        this.diff[p] = re * this.prev[2 * p] + im * this.prev[2 * p + 1];
        this.prev[2 * p] = re;
        this.prev[2 * p + 1] = im;
        this.energy[p] = 0.995 * this.energy[p] + 0.005 * (re * re + im * im);
        if (this.energy[p] > this.energy[best]) best = p;
      }
      this._bit(this.diff[best] < 0 ? 1 : 0);   // Polarity change = 1 (differential code)
      // Keep the best phase near the middle by moving the bit clock, so it
      // never wraps across a bit boundary (which would slip a bit)
      const shift = Math.abs(best - RDS_PHASES / 2) > 2 ? best - RDS_PHASES / 2 : 0;
      if (shift) {
        const e = this.energy.slice(), pv = this.prev.slice();
        for (let p = 0; p < RDS_PHASES; p++) {
          const q = p + shift, inside = q >= 0 && q < RDS_PHASES;
          this.energy[p] = inside ? e[q] : 0;
          this.prev[2 * p] = inside ? pv[2 * q] : 0;
          this.prev[2 * p + 1] = inside ? pv[2 * q + 1] : 0;
        }
      }
      this.next += RDS_BIT * (1 + shift / RDS_PHASES);
    }
    const drop = Math.floor(this.next) - this.base - 4;
    if (drop > 0) {
      this.ci = ci.slice(drop);
      this.cq = cq.slice(drop);
      this.base += drop;
    } else {
      this.ci = ci;
      this.cq = cq;
    }
  }

  _bit(bit) {
    this.reg = ((this.reg << 1) | bit) & 0x3ffffff;
    this.nbits++;
    if (this.nbits < 26) return;
    const data = this.reg >>> 10, check = this.reg & 0x3ff, syn = rdsSyndrome(data, 16);
    if (!this.sync) {
      // Two blocks 26 bits apart, in group order, give sync
      const off = RDS_OFFSETS.findIndex((o) => (check ^ o) === syn);
      if (off < 0) return;
      const l = this.last;
      if (l && this.nbits - l.at === 26 && RDS_ORDER[off] === (RDS_ORDER[l.off] + 1) % 4) {
        this.sync = true;
        this.bad = 0;
        this.blockBits = 0;
        this.group = [];
        this.group[RDS_ORDER[l.off]] = l.data;
        this.group[RDS_ORDER[off]] = data;
        if (RDS_ORDER[off] === 3) this._group(this.group);
        this.expect = (RDS_ORDER[off] + 1) % 4;
      }
      this.last = { off, at: this.nbits, data };
      return;
    }
    if (++this.blockBits < 26) return;
    this.blockBits = 0;
    let ok = (check ^ RDS_OFFSETS[this.expect]) === syn;
    if (!ok && this.expect === 2) ok = (check ^ RDS_OFFSETS[4]) === syn;   // C' in version B groups
    if (ok) this.bad = Math.max(0, this.bad - 1);
    else if (++this.bad > 8) { this.sync = false; this.last = null; return; }
    if (this.expect === 0) this.group = [];
    this.group[this.expect] = ok ? data : null;
    if (this.expect === 3) this._group(this.group);
    this.expect = (this.expect + 1) % 4;
  }

  _group([a, b, , d]) {
    if (a != null) {
      const pi = a.toString(16).toUpperCase().padStart(4, "0");
      if (pi !== this.pi) { this.pi = pi; this._update(); }
    }
    if (b == null || d == null || b >> 11 > 1) return;   // Group type 0 (0A or 0B) carries the name
    const seg = b & 3;
    const ch = (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : " ");
    this.ps[2 * seg] = ch(d >> 8);
    this.ps[2 * seg + 1] = ch(d & 0xff);
    this.seen |= 1 << seg;
    if (this.seen === 15) {
      const name = this.ps.join("").trim();
      if (name && name !== this.name) { this.name = name; this._update(); }
    }
  }

  _update() {
    this.onUpdate?.({ ps: this.name, pi: this.pi });
  }
}

// ===================================================================== codec
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Terminated convolutional code, rate 1/R, with a soft Viterbi decoder. */
export class ConvCode {
  constructor(K = 9, polys = [0o557, 0o663, 0o711]) {
    this.K = K;
    this.R = polys.length;
    this.polys = polys;
    const S = (this.S = 1 << (K - 1)), R = this.R;
    const parity = (v) => { let p = 0; while (v) { p ^= v & 1; v >>= 1; } return p; };
    this.out = (s, b) => polys.map((p) => parity(((b << (K - 1)) | s) & p));
    this.p = [new Int32Array(S), new Int32Array(S)];
    this.b = [new Uint8Array(S), new Uint8Array(S)];
    this.sign = [new Float32Array(S * R), new Float32Array(S * R)];
    const cnt = new Int32Array(S);
    for (let s = 0; s < S; s++) {
      for (let b = 0; b < 2; b++) {
        const nx = ((b << (K - 1)) | s) >> 1, i = cnt[nx]++;
        this.p[i][nx] = s;
        this.b[i][nx] = b;
        this.out(s, b).forEach((o, r) => (this.sign[i][nx * R + r] = 1 - 2 * o));
      }
    }
  }

  encode(bits) {
    const out = [];
    let s = 0;
    for (const b of [...bits, ...new Array(this.K - 1).fill(0)]) {
      out.push(...this.out(s, b));
      s = ((b << (this.K - 1)) | s) >> 1;
    }
    return Uint8Array.from(out);
  }

  /** llr > 0 means bit 0. */
  decode(llr) {
    const S = this.S, R = this.R, T = Math.floor(llr.length / R);
    let pm = new Float64Array(S).fill(-1e30), nm = new Float64Array(S);
    pm[0] = 0;
    const dec = new Uint8Array(T * S);
    const [p0, p1] = this.p, [g0, g1] = this.sign;
    for (let t = 0; t < T; t++) {
      const o = t * R;
      for (let s = 0; s < S; s++) {
        let m0 = pm[p0[s]], m1 = pm[p1[s]];
        for (let r = 0; r < R; r++) {
          m0 += g0[s * R + r] * llr[o + r];
          m1 += g1[s * R + r] * llr[o + r];
        }
        if (m1 > m0) { nm[s] = m1; dec[t * S + s] = 1; } else { nm[s] = m0; }
      }
      [pm, nm] = [nm, pm];
    }
    const bits = new Uint8Array(T);
    for (let t = T - 1, s = 0; t >= 0; t--) {
      const i = dec[t * S + s];
      bits[t] = this.b[i][s];
      s = this.p[i][s];
    }
    return bits.subarray(0, T - (this.K - 1));
  }

  /**
   * Parallel list Viterbi: the L best paths ending in state 0, best first.
   * Each state keeps its L best (sorted) metrics; a step merges the two
   * predecessors' lists.
   */
  decodeList(llr, L) {
    const S = this.S, R = this.R, T = Math.floor(llr.length / R);
    let pm = new Float64Array(S * L).fill(-1e30), nm = new Float64Array(S * L);
    pm[0] = 0;
    const dec = new Uint8Array(T * S * L);             // which * L + rank of the predecessor
    const [p0, p1] = this.p, [g0, g1] = this.sign;
    for (let t = 0; t < T; t++) {
      const o = t * R;
      for (let s = 0; s < S; s++) {
        let b0 = 0, b1 = 0;
        for (let r = 0; r < R; r++) { b0 += g0[s * R + r] * llr[o + r]; b1 += g1[s * R + r] * llr[o + r]; }
        const a = p0[s] * L, b = p1[s] * L, d = (t * S + s) * L;
        for (let k = 0, i = 0, j = 0; k < L; k++) {
          const m0 = pm[a + i] + b0, m1 = pm[b + j] + b1;
          if (m0 >= m1) { nm[s * L + k] = m0; dec[d + k] = i++; }
          else { nm[s * L + k] = m1; dec[d + k] = L + j++; }
        }
      }
      [pm, nm] = [nm, pm];
    }
    const out = [];
    for (let r = 0; r < L && pm[r] > -1e29; r++) {
      const bits = new Uint8Array(T);
      for (let t = T - 1, s = 0, rank = r; t >= 0; t--) {
        const j = dec[(t * S + s) * L + rank], w = j >= L ? 1 : 0;
        rank = j - w * L;
        bits[t] = this.b[w][s];
        s = this.p[w][s];
      }
      out.push(bits.subarray(0, T - (this.K - 1)));
    }
    return out;
  }
}

const CODE = new ConvCode();
const LIST_SIZE = 8;              // List Viterbi paths tried when the best one fails the CRC

/** Frame geometry for a configuration. */
export function frameLayout(cfg) {
  const N = 1 << cfg.sf;
  const nPre = cfg.nDown + cfg.nUp;
  const nInfo = (cfg.msgLen + 2) * 8;
  const nCoded = (nInfo + CODE.K - 1) * CODE.R;
  const nData = Math.ceil(nCoded / cfg.sf);
  const chirps = nPre + nData;
  return { N, nPre, nInfo, nCoded, nData, chirps, frameLen: chirps * N, seconds: (chirps * N) / cfg.bw };
}

/** Data symbols for a message, exactly as the firmware's build_frame(). */
export function encodeFrame(text, cfg) {
  const L = frameLayout(cfg);
  const frame = new Uint8Array(cfg.msgLen + 2);
  frame.set(new TextEncoder().encode(text).subarray(0, cfg.msgLen));
  const crc = crc16(frame.subarray(0, cfg.msgLen));
  frame[cfg.msgLen] = crc >> 8;
  frame[cfg.msgLen + 1] = crc & 0xff;
  const bits = [];
  for (const b of frame) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  const coded = CODE.encode(bits);
  const symBits = new Uint16Array(L.nData);
  coded.forEach((c, j) => {
    const s = j % L.nData, pos = (Math.floor(j / L.nData) + s) % cfg.sf;
    symBits[s] |= c << (cfg.sf - 1 - pos);
  });
  return Array.from(symBits, (v) => { let s = v; for (let g = v >> 1; g; g >>= 1) s ^= g; return s; });
}

/** x(n + d) for a fractional d, by a phase ramp in the frequency domain (interleaved complex). */
function fracAdvance(x, d) {
  const n = x.length >> 1, P = nextPow2(n), f = FFT.of(P);
  const re = new Float64Array(P), im = new Float64Array(P);
  for (let i = 0; i < n; i++) { re[i] = x[2 * i]; im[i] = x[2 * i + 1]; }
  f.transform(re, im);
  for (let k = 0; k < P; k++) {
    const ph = (2 * Math.PI * (k < P / 2 ? k : k - P) * d) / P, c = Math.cos(ph), sn = Math.sin(ph);
    const r = re[k] * c - im[k] * sn;
    im[k] = re[k] * sn + im[k] * c;
    re[k] = r;
  }
  f.transform(re, im, true);
  const out = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) { out[2 * i] = re[i] / P; out[2 * i + 1] = im[i] / P; }
  return out;
}

// ===================================================================== statistics
function logI0(x) {
  if (x < 3.75) {
    const t = (x / 3.75) ** 2;
    return Math.log(1 + t * (3.5156229 + t * (3.0899424 + t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813))))));
  }
  const t = 3.75 / x;
  return x - 0.5 * Math.log(x) + Math.log(0.39894228 + t * (0.01328592 + t * (0.00225319 + t * (-0.00157565 +
    t * (0.00916281 + t * (-0.02057706 + t * (0.02635537 + t * (-0.01647633 + t * 0.00392377))))))));
}

function logGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5, ser = 1.000000000190015;
  tmp -= (x + 0.5) * Math.log(tmp);
  for (const v of c) ser += v / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Regularised upper incomplete gamma Q(a, x). */
function gammaQ(a, x) {
  if (x <= 0) return 1;
  const gln = logGamma(a);
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) { del *= x / ++ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** x with Q(a, x) = p. */
function gammaIsf(p, a) {
  let lo = 0, hi = a + 60 * Math.sqrt(a) + 100;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (gammaQ(a, mid) > p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function median(arr) {
  const a = Float64Array.from(arr).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

function gaussian() {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

// ===================================================================== receiver
export const AWGN_OFF = 99;

/**
 * Multi-station LoRAB frame receiver. push() one baseband block per station
 * (interleaved complex at cfg.bw, all the same length and time-aligned).
 * onFrame(event) fires for every frame found.
 */
export class LorabReceiver {
  static FINE_W = 3;
  static SLOT_W = 24;
  static LOCK_MISSES = 4;
  static MED_THR = 1.2;
  static HOMOG = 5;
  static ZPAD = 4;

  constructor(cfg, labels, { onFrame, onLog } = {}) {
    this.cfg = cfg;
    this.labels = labels;
    this.S = labels.length;
    this.onFrame = onFrame || (() => {});
    this.onLog = onLog || (() => {});
    Object.assign(this, frameLayout(cfg));
    const N = this.N;
    this.period = this.periodNom = cfg.txPeriod * cfg.bw;
    this.maxCombine = Math.max(1, cfg.maxCombine);

    this.up = { re: new Float64Array(N), im: new Float64Array(N) };
    for (let n = 0; n < N; n++) {
      const ph = 2 * Math.PI * ((n * n) / (2 * N) - n / 2);
      this.up.re[n] = Math.cos(ph);
      this.up.im[n] = Math.sin(ph);
    }
    this.bitmat = new Uint8Array(N * cfg.sf);
    for (let k = 0; k < N; k++) {
      const g = k ^ (k >> 1);
      for (let b = 0; b < cfg.sf; b++) this.bitmat[k * cfg.sf + b] = (g >> (cfg.sf - 1 - b)) & 1;
    }
    this.ilSym = new Int32Array(this.nCoded);
    this.ilBit = new Int32Array(this.nCoded);
    for (let j = 0; j < this.nCoded; j++) {
      this.ilSym[j] = j % this.nData;
      this.ilBit[j] = (Math.floor(j / this.nData) + (j % this.nData)) % cfg.sf;
    }
    this.detThr = gammaIsf(1e-6, this.nPre * this.S) / this.S;
    this.presenceThr = gammaIsf(1e-2, this.nPre * this.S) / this.S;
    this.corrTemplates = new Map();

    this.buf = labels.map(() => new Float32Array(0));
    this.used = 0;                // Floats in use in each buf (same for all stations)
    this.bb0 = 0;
    this.scanPos = 0;
    this.obs = [];
    this.locked = false;
    this.nextSlot = null;
    this.anchor = null;
    this.misses = 0;
    this.nu = new Float64Array(this.S);
    this.frames = 0;
    this.decoded = 0;
    this.awgnSnr = AWGN_OFF;
    this.awgnSigma = new Float64Array(this.S);
    this.cleanPs = labels.map(() => []);
    this.awgnPs = null;
  }

  // ------------------------------------------------------------- AWGN test
  setAwgn(snrDb) {
    this.awgnSnr = snrDb;
    this.awgnPs = snrDb >= AWGN_OFF ? null : this.awgnPs;
    this._updateAwgn();
  }

  _updateAwgn() {
    this.awgnSigma.fill(0);
    if (this.awgnSnr >= AWGN_OFF) return;
    if (!this.awgnPs && this.cleanPs.every((p) => p.length)) this.awgnPs = this.cleanPs.map((p) => median(p.slice(-5)));
    if (!this.awgnPs) { this.onLog("AWGN test armed: waiting for a clean frame to measure the tag power"); return; }
    this.awgnPs.forEach((ps, s) => (this.awgnSigma[s] = Math.sqrt(ps / 10 ** (this.awgnSnr / 10) / 2)));
    this.onLog(`AWGN test: in-band SNR set to ${this.awgnSnr.toFixed(1)} dB on every station`);
  }

  // ------------------------------------------------------------- streaming
  push(blocks) {
    blocks.forEach((b, s) => {
      const used = this.used;
      if (this.buf[s].length < used + b.length) {
        const nb = new Float32Array(2 * (used + b.length));   // Amortised growth
        nb.set(this.buf[s].subarray(0, used));
        this.buf[s] = nb;
      }
      const dst = this.buf[s];
      dst.set(b, used);
      const g = this.awgnSigma[s];
      if (g > 0) for (let i = used; i < used + b.length; i++) dst[i] += g * gaussian();
    });
    this.used += blocks[0].length;
    this._process(false);
  }

  get end() {
    return this.bb0 + (this.used >> 1);
  }

  _seg(s, start, len) {
    const i = start - this.bb0;
    if (i < 0 || (i + len) * 2 > this.used) return null;
    return this.buf[s].subarray(2 * i, 2 * (i + len));
  }

  _templates(P) {
    let t = this.corrTemplates.get(P);
    if (t) return t;
    const f = FFT.of(P), N = this.N;
    const mk = (sign) => {
      const re = new Float64Array(P), im = new Float64Array(P);
      for (let n = 0; n < N; n++) { re[n] = this.up.re[n]; im[n] = sign * this.up.im[n]; }
      f.transform(re, im);
      for (let i = 0; i < P; i++) im[i] = -im[i];            // conj(FFT(template))
      return { re, im };
    };
    t = { down: mk(-1), up: mk(1) };
    this.corrTemplates.set(P, t);
    return t;
  }

  /**
   * Preamble metric for lags start..start+nLags-1, averaged over stations.
   * Per chirp: matched-filter energy / window energy (CFAR). Returns the sum
   * over the preamble chirps and a mask of lags where the energy is spread
   * evenly over them, as a real preamble's is.
   */
  _metric(start, nLags) {
    const N = this.N, nPre = this.nPre, nDown = this.cfg.nDown;
    const segLen = nLags + nPre * N, P = nextPow2(segLen + N), f = FFT.of(P), T = this._templates(P);
    const terms = Array.from({ length: nPre }, () => new Float64Array(nLags));
    for (let s = 0; s < this.S; s++) {
      const seg = this._seg(s, start, segLen);
      if (!seg) return null;
      const xr = new Float64Array(P), xi = new Float64Array(P);
      const cum = new Float64Array(segLen + 1);
      for (let n = 0; n < segLen; n++) {
        xr[n] = seg[2 * n]; xi[n] = seg[2 * n + 1];
        cum[n + 1] = cum[n] + xr[n] * xr[n] + xi[n] * xi[n];
      }
      f.transform(xr, xi);
      const corr = (tp) => {
        const re = new Float64Array(P), im = new Float64Array(P);
        for (let i = 0; i < P; i++) {
          re[i] = xr[i] * tp.re[i] - xi[i] * tp.im[i];
          im[i] = xr[i] * tp.im[i] + xi[i] * tp.re[i];
        }
        f.transform(re, im, true);
        const e = new Float64Array(segLen - N + 1);
        for (let t = 0; t < e.length; t++) {
          const w = Math.max(cum[t + N] - cum[t], 1e-30);
          e[t] = (re[t] * re[t] + im[t] * im[t]) / (P * P) / w;
        }
        return e;
      };
      const cd = corr(T.down), cu = corr(T.up);
      for (let k = 0; k < nPre; k++) {
        const src = k < nDown ? cd : cu, o = k * N, dst = terms[k];
        for (let t = 0; t < nLags; t++) dst[t] += src[o + t] / this.S;
      }
    }
    const sum = new Float64Array(nLags), even = new Uint8Array(nLags);
    const tmp = new Float64Array(nDown);
    for (let t = 0; t < nLags; t++) {
      let maxUp = 0;
      for (let k = 0; k < nPre; k++) {
        sum[t] += terms[k][t];
        if (k < nDown) tmp[k] = terms[k][t]; else maxUp = Math.max(maxUp, terms[k][t]);
      }
      tmp.sort();
      const med = nDown % 2 ? tmp[nDown >> 1] : 0.5 * (tmp[nDown / 2 - 1] + tmp[nDown / 2]);
      even[t] = med >= LorabReceiver.MED_THR && maxUp <= LorabReceiver.HOMOG * (med + 1) ? 1 : 0;
    }
    return { sum, even };
  }

  flush() {
    this._process(true);
  }

  _process(final) {
    const N = this.N, W = LorabReceiver.SLOT_W;
    for (;;) {
      const lagEnd = this.end - this.frameLen - W - 1;
      let nLags = lagEnd - this.scanPos;
      if (nLags < (final ? 1 : 4 * N + this.nPre * N)) break;
      nLags = Math.min(nLags, 16 * N + this.nPre * N);
      const accept = final ? nLags : nLags - this.nPre * N;
      const m = this._metric(this.scanPos, nLags);
      const cands = [];
      if (m) {
        const v = m.sum.map((x, i) => (m.even[i] ? x : 0));
        for (;;) {
          let i = 0;
          for (let j = 1; j < v.length; j++) if (v[j] > v[i]) i = j;
          if (v[i] < this.detThr || i >= accept) break;
          // While locked, frames on the timing grid are handled as predicted
          // frames; a detection there is the same frame or a misalignment of it
          if (!this.locked || !this._onGrid(this.scanPos + i)) cands.push({ t: this.scanPos + i, forced: false });
          v.fill(0, Math.max(0, i - this.frameLen), i + this.frameLen);
        }
      }
      this.scanPos += accept;
      if (this.locked) {
        while (this.nextSlot !== null && this.nextSlot <= this.scanPos) {
          cands.push({ t: Math.round(this.nextSlot), forced: true });
          this.nextSlot += this.period;
        }
      }
      cands.sort((a, b) => a.t - b.t);
      for (const c of cands) this._candidate(c.t, c.forced ? W : LorabReceiver.FINE_W, c.forced);
    }
    let keepFrom = this.scanPos - W - N;
    if (this.locked && this.nextSlot !== null) keepFrom = Math.min(keepFrom, Math.floor(this.nextSlot) - W - N);
    const drop = keepFrom - this.bb0;
    if (drop > 0) {
      for (const b of this.buf) b.copyWithin(0, 2 * drop, this.used);
      this.used -= 2 * drop;
      this.bb0 += drop;
    }
  }

  _candidate(t0, w, forced) {
    const m = this._metric(t0 - w, 2 * w + 1);
    if (!m) return;
    const v = m.sum;
    let i = 0;
    for (let j = 1; j < v.length; j++) if (v[j] > v[i]) i = j;
    let frac = 0;
    if (i > 0 && i < v.length - 1) {
      const den = v[i - 1] - 2 * v[i] + v[i + 1];
      frac = den < 0 ? (0.5 * (v[i - 1] - v[i + 1])) / den : 0;
    }
    const t = t0 - w + i, peak = v[i];
    for (const o of this.obs) {
      const dt = Math.abs(o.t - t);
      if (dt <= LorabReceiver.SLOT_W) return;
      if (dt < this.frameLen) {
        if (o.done || o.peak >= peak) return;
        this.obs.splice(this.obs.indexOf(o), 1);
        this.frames--;
        break;
      }
    }
    if (forced) {
      if (peak < this.presenceThr) {
        if (++this.misses >= LorabReceiver.LOCK_MISSES) {
          this.locked = false;
          this.onLog("Lock lost: no frames at the expected time");
        }
        return;
      }
      this.misses = 0;
    }

    const per = [];
    for (let s = 0; s < this.S; s++) {
      const d = this._demod(s, t);
      if (!d) return;
      per.push(d);
    }
    this.frames++;
    const llSum = new Float32Array(per[0].ll.length);
    for (const d of per) for (let i = 0; i < llSum.length; i++) llSum[i] += d.ll[i];
    const ob = { t: t + frac, ll: llSum, peak, decoded: false };
    this.obs.push(ob);
    const horizon = (this.maxCombine + 1) * this.period;
    this.obs = this.obs.filter((o) => ob.t - o.t <= horizon);

    // Each station alone (for display), then all stations together, then repeats
    const stations = per.map((d, s) => ({ label: this.labels[s], snr: d.snr, ok: this.S > 1 ? this._decode(d.ll) !== null : false }));
    let text = this._decode(llSum), nComb = 1;
    if (this.S === 1) stations[0].ok = text !== null;
    if (text === null && this.maxCombine > 1) [text, nComb] = this._combine(ob);
    if (text === null && !forced && this.locked) {
      // Off the locked frame grid and not decodable: a noise detection
      this.obs.splice(this.obs.indexOf(ob), 1);
      this.frames--;
      return;
    }
    const snr = 10 * Math.log10(per.reduce((a, d) => a + 10 ** (d.snr / 10), 0));
    ob.snr = snr;
    const event = {
      time: ob.t / this.cfg.bw, text, snr, stations, frames: nComb,
      pending: text === null ? 1 + this._consistent(ob).length : 0,
      awgn: this.awgnSnr < AWGN_OFF && this.awgnSigma[0] > 0 ? this.awgnSnr : null,
    };
    if (text !== null) {
      ob.decoded = nComb === 1;   // Decoded alone: left out of later combining
      ob.done = true;
      this.decoded++;
      if (nComb === 1) {
        per.forEach((d, s) => {
          if (this.awgnSigma[s] === 0) this.cleanPs[s] = [...this.cleanPs[s], d.a2 / (this.N * this.N)].slice(-20);
        });
        if (this.awgnSnr < AWGN_OFF && !this.awgnPs) this._updateAwgn();
      }
      this._lockTo(ob);
      if (nComb > 1) event.snr = this._combinedSnr(ob, nComb);
    }
    event.decoded = this.decoded;
    event.seen = this.frames;
    event.inspect = this._inspect(per, llSum, text);
    this.onFrame(event);
  }

  /** Symbol map of the strongest station, and how many symbols the code had to fix. */
  _inspect(per, llSum, text) {
    const N = this.N, best = per.reduce((b, d, i) => (d.snr > per[b].snr ? i : b), 0);
    const hard = new Int16Array(this.nData);
    for (let i = 0; i < this.nData; i++) {
      let k0 = 0;
      for (let k = 1; k < N; k++) if (llSum[i * N + k] > llSum[i * N + k0]) k0 = k;
      hard[i] = k0;
    }
    const expected = text === null ? null : Int16Array.from(encodeFrame(text, this.cfg));
    const errors = expected ? hard.reduce((a, h, i) => a + (h !== expected[i]), 0) : null;
    return { map: per[best].map, label: this.labels[best], N, nPre: this.nPre, nData: this.nData,
      hard, expected, errors };
  }

  _lockTo(ob) {
    if (this.anchor !== null) {
      const dt = ob.t - this.anchor, m = Math.round(dt / this.periodNom);
      if (m >= 1 && Math.abs(dt - m * this.period) < 4 + 3 * m) {
        const p = dt / m;
        this.period = this.locked ? 0.7 * this.period + 0.3 * p : p;
      }
    }
    if (!this.locked) this.onLog(`Locked to frame timing (period ${(this.period / this.cfg.bw).toFixed(4)} s)`);
    this.anchor = ob.t;
    this.locked = true;
    this.misses = 0;
    this.nextSlot = ob.t + this.period;
  }

  _onGrid(t) {
    const d = (((t - this.anchor) % this.period) + this.period) % this.period;
    return Math.min(d, this.period - d) < this.frameLen / 2;
  }

  _consistent(ob) {
    const out = [];
    for (let i = this.obs.length - 1; i >= 0; i--) {
      const o = this.obs[i];
      if (o === ob || o.decoded) continue;
      const dt = ob.t - o.t, m = Math.round(dt / this.period);
      if (m >= 1 && Math.abs(dt - m * this.period) <= 4 + 3 * m) out.push(o);
    }
    return out.slice(0, this.maxCombine - 1);
  }

  _combine(ob) {
    const ll = ob.ll.slice();
    let k = 1;
    for (const o of this._consistent(ob)) {
      for (let i = 0; i < ll.length; i++) ll[i] += o.ll[i];
      k++;
      const text = this._decode(ll);
      if (text !== null) return [text, k];
    }
    return [null, 1];
  }

  _combinedSnr(ob, n) {
    const g = [ob, ...this._consistent(ob).slice(0, n - 1)];
    return 10 * Math.log10(g.reduce((a, o) => a + 10 ** (o.snr / 10), 0) / g.length);
  }

  // ------------------------------------------------------------- demodulation
  _peakOffset(spec) {
    const Z = LorabReceiver.ZPAD, L = spec.length, w = Math.floor(2.5 * Z);
    let best = -w, bv = -Infinity;
    const at = (k) => spec[((k % L) + L) % L];
    for (let k = -w; k <= w; k++) if (at(k) > bv) { bv = at(k); best = k; }
    let frac = 0;
    if (best > -w && best < w) {
      const a = at(best - 1), b = at(best), c = at(best + 1), den = a - 2 * b + c;
      frac = den < 0 ? (0.5 * (a - c)) / den : 0;
    }
    return (best + frac) / Z;
  }

  /** |FFT|^2 of each chirp of x (dechirped by tmpl with conj when conjT), times an optional ramp. */
  _chirpSpectra(x, first, count, conjT, nfft, offsetBins) {
    const N = this.N, f = FFT.of(nfft), out = [];
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    const tr = this.up.re, ti = this.up.im, sg = conjT ? -1 : 1;
    for (let c = 0; c < count; c++) {
      re.fill(0); im.fill(0);
      const o = 2 * (first + c) * N;
      for (let n = 0; n < N; n++) {
        let ar = tr[n], ai = sg * ti[n];
        if (offsetBins) {
          const ph = (-2 * Math.PI * offsetBins * n) / N, cr = Math.cos(ph), ci = Math.sin(ph);
          const t = ar * cr - ai * ci; ai = ar * ci + ai * cr; ar = t;
        }
        const xr = x[o + 2 * n], xi = x[o + 2 * n + 1];
        re[n] = xr * ar - xi * ai;
        im[n] = xr * ai + xi * ar;
      }
      f.transform(re, im);
      const e = new Float64Array(nfft);
      for (let k = 0; k < nfft; k++) e[k] = re[k] * re[k] + im[k] * im[k];
      out.push(e);
    }
    return out;
  }

  _demod(s, t) {
    const N = this.N, Z = LorabReceiver.ZPAD, nDown = this.cfg.nDown, nUp = this.cfg.nUp;
    const raw = this._seg(s, Math.floor(t), this.frameLen);
    if (!raw) return null;
    // Down-chirps dechirped by the up-chirp -> tones at nu + delta, up-chirps by the down-chirp -> nu - delta
    const sumSpec = (arr) => arr.reduce((a, e) => { for (let k = 0; k < e.length; k++) a[k] += e[k]; return a; }, new Float64Array(arr[0].length));
    const oD = this._peakOffset(sumSpec(this._chirpSpectra(raw, 0, nDown, false, Z * N, 0)));
    const oU = this._peakOffset(sumSpec(this._chirpSpectra(raw, nDown, nUp, true, Z * N, 0)));
    const delta = 0.5 * (oD - oU), nu = this.nu[s];
    // A fractional timing offset is not just a tone shift for data chirps: at
    // the chirp's wrap it adds a 2*pi*delta phase jump that splits the tone
    // between two bins. So remove it in the time domain first.
    const x = Math.abs(delta) > 0.02 ? fracAdvance(raw, delta) : raw;

    const Ep = [...this._chirpSpectra(x, 0, nDown, false, N, nu),
      ...this._chirpSpectra(x, nDown, nUp, true, N, nu)];
    let a2 = 0, s2p = 0;
    for (const e of Ep) { const s2 = median(e) / Math.LN2; a2 += e[0] - s2; s2p += s2; }
    a2 = Math.max(a2 / Ep.length, (1e-3 * s2p) / Ep.length);

    const E = this._chirpSpectra(x, this.nPre, this.nData, true, N, nu);
    const ll = new Float32Array(this.nData * N);
    const a = Math.sqrt(a2);
    let s2sum = 0;
    E.forEach((e, i) => {
      const s2 = median(e) / Math.LN2;
      s2sum += s2;
      for (let k = 0; k < N; k++) ll[i * N + k] = logI0((2 * a * Math.sqrt(e[k])) / s2);
    });
    const snr = 10 * Math.log10(a2 / ((N * s2sum) / this.nData));
    if (snr > -10) this.nu[s] = 0.9 * this.nu[s] + 0.1 * 0.5 * (oD + oU);

    // Dechirped energy of every chirp, dB above its noise floor, 0..255 (for the packet view)
    const map = new Uint8Array((this.nPre + this.nData) * N);
    [...Ep, ...E].forEach((e, c) => {
      const s2 = median(e) / Math.LN2;
      for (let k = 0; k < N; k++) {
        const db = 10 * Math.log10(e[k] / s2 + 1e-9);
        map[c * N + k] = Math.max(0, Math.min(255, Math.round(((db + 3) / 30) * 255)));
      }
    });
    return { ll, snr, a2, map };
  }

  _decode(ll) {
    const N = this.N, sf = this.cfg.sf, bitLlr = new Float32Array(this.nData * sf);
    const p = new Float64Array(N);
    for (let i = 0; i < this.nData; i++) {
      let m = -Infinity;
      for (let k = 0; k < N; k++) m = Math.max(m, ll[i * N + k]);
      let tot = 0;
      for (let k = 0; k < N; k++) tot += (p[k] = Math.exp(ll[i * N + k] - m));
      for (let b = 0; b < sf; b++) {
        let p1 = 0;
        for (let k = 0; k < N; k++) if (this.bitmat[k * sf + b]) p1 += p[k];
        bitLlr[i * sf + b] = Math.log(Math.max(tot - p1, 1e-300)) - Math.log(Math.max(p1, 1e-300));
      }
    }
    const llr = new Float32Array(this.nCoded);
    for (let j = 0; j < this.nCoded; j++) llr[j] = bitLlr[this.ilSym[j] * sf + this.ilBit[j]];
    const text = this._check(CODE.decode(llr));
    if (text !== null) return text;
    // Viterbi's best path failed the CRC: try the next best paths
    for (const bits of CODE.decodeList(llr, LIST_SIZE).slice(1)) {
      const t = this._check(bits);
      if (t !== null) return t;
    }
    return null;
  }

  /** Text if the frame's CRC and characters are valid, else null. */
  _check(bits) {
    const bytes = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bits.length; i++) bytes[i >> 3] |= bits[i] << (7 - (i & 7));
    const L = this.cfg.msgLen;
    if (crc16(bytes.subarray(0, L)) !== ((bytes[L] << 8) | bytes[L + 1])) return null;
    let end = L;
    while (end > 0 && bytes[end - 1] === 0) end--;
    for (let i = 0; i < end; i++) if (bytes[i] < 32 || bytes[i] > 126) return null;
    return new TextDecoder().decode(bytes.subarray(0, end));
  }
}
