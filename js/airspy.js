// Airspy R2 / Mini driver over WebUSB.
//
// Mirrors libairspy (airspyone_host/libairspy/src/airspy.c): same vendor
// requests, same open sequence, same raw sample format. No native driver is
// needed; the browser talks to the device directly.
//   Linux:   needs a udev rule giving your user access (see README).
//   Windows: the device must use the WinUSB driver (Airspy's default / Zadig).
//   macOS, ChromeOS, Android (OTG): works as is.

export const AIRSPY_VID = 0x1d50;
export const AIRSPY_PID = 0x60a1;

const REQ = {
  RECEIVER_MODE: 1,
  BOARD_ID_READ: 9,
  VERSION_STRING_READ: 10,
  BOARD_PARTID_SERIALNO_READ: 11,
  SET_SAMPLERATE: 12,
  SET_FREQ: 13,
  SET_LNA_GAIN: 14,
  SET_MIXER_GAIN: 15,
  SET_VGA_GAIN: 16,
  SET_LNA_AGC: 17,
  SET_MIXER_AGC: 18,
  GET_SAMPLERATES: 25,
  SET_PACKING: 26,
};

// libairspy linearity gain tables (index = 21 - gain)
const LIN_VGA = [13, 12, 11, 11, 11, 11, 11, 10, 10, 10, 10, 10, 10, 10, 10, 10, 9, 8, 7, 6, 5, 4];
const LIN_MIXER = [12, 12, 11, 9, 8, 7, 6, 6, 5, 0, 0, 1, 0, 0, 2, 2, 1, 1, 1, 1, 0, 0];
const LIN_LNA = [14, 14, 14, 13, 12, 10, 9, 9, 8, 9, 8, 6, 5, 3, 1, 0, 0, 0, 0, 0, 0, 0];
export const GAIN_STEPS = 22;

const TRANSFER_BYTES = 262144;   // libairspy buffer_size (unpacked)
const TRANSFERS = 16;            // libairspy transfer_count

export class Airspy {
  static filters = [{ vendorId: AIRSPY_VID, productId: AIRSPY_PID }];

  /** Ask the user to pick an Airspy (needs a click). */
  static async request(usb = globalThis.navigator?.usb) {
    return new Airspy(await usb.requestDevice({ filters: Airspy.filters }));
  }

  static matches(d) {
    return d.vendorId === AIRSPY_VID && d.productId === AIRSPY_PID;
  }

  /** An Airspy the user already granted to this site, or null. */
  static async paired(usb = globalThis.navigator?.usb) {
    const devs = await usb.getDevices();
    const d = devs.find((d) => Airspy.matches(d));
    return d ? new Airspy(d) : null;
  }

  constructor(device) {
    this.dev = device;
    this.format = "airspy";              // uint16 real samples at twice the sample rate
    this.streaming = false;
    this.run = 0;                        // Streaming session; transfer loops of an older one exit
    this.sampleRates = [];
    this.sampleRate = 0;
  }

  async open() {
    const d = this.dev;
    if (!d.opened) await d.open();
    if (!d.configuration || d.configuration.configurationValue !== 1) await d.selectConfiguration(1);
    await d.claimInterface(0);
    await this.setReceiverMode(0);
    this.boardId = (await this._in(REQ.BOARD_ID_READ, 0, 0, 1)).getUint8(0);
    this.version = decodeString(await this._in(REQ.VERSION_STRING_READ, 0, 0, 127));
    const sn = await this._in(REQ.BOARD_PARTID_SERIALNO_READ, 0, 0, 24);
    this.serial = hex32(sn.getUint32(16, true)) + hex32(sn.getUint32(20, true));
    this.sampleRates = await this._readSampleRates();
    await this._in(REQ.SET_PACKING, 0, 0, 1);
    this.model = this.sampleRates.includes(6000000) || this.sampleRates.includes(3000000) ? "Airspy Mini" : "Airspy R2";
    return this;
  }

  async close() {
    await this.stop();
    try { await this.dev.releaseInterface(0); } catch { /* already released */ }
    try { await this.dev.close(); } catch { /* already closed */ }
  }

  get name() {
    return `${this.model} (SN ${this.serial})`;
  }

  async _readSampleRates() {
    try {
      const n = (await this._in(REQ.GET_SAMPLERATES, 0, 0, 4)).getUint32(0, true);
      const d = await this._in(REQ.GET_SAMPLERATES, 0, n, n * 4);
      return Array.from({ length: n }, (_, i) => d.getUint32(i * 4, true));
    } catch {
      return [10000000, 2500000];   // libairspy fallback for old firmware
    }
  }

  /** IQ sample rate in S/s; must be one of this.sampleRates. */
  async setSampleRate(rate) {
    const i = this.sampleRates.indexOf(rate);
    if (i < 0) throw new Error(`Unsupported sample rate ${rate}`);
    await this.dev.clearHalt("in", 1);
    await this._in(REQ.SET_SAMPLERATE, 0, i, 1);
    this.sampleRate = rate;
  }

  async setFrequency(hz) {
    const b = new DataView(new ArrayBuffer(4));
    b.setUint32(0, Math.round(hz), true);
    await this._out(REQ.SET_FREQ, 0, 0, b.buffer);
    this.frequency = Math.round(hz);
  }

  /** Automatic gain (LNA + mixer AGC). */
  async setAgc(on) {
    await this._in(REQ.SET_LNA_AGC, 0, on ? 1 : 0, 1);
    await this._in(REQ.SET_MIXER_AGC, 0, on ? 1 : 0, 1);
  }

  /** Manual gain 0..21, libairspy "linearity" profile. */
  async setLinearityGain(g) {
    const i = GAIN_STEPS - 1 - Math.max(0, Math.min(GAIN_STEPS - 1, Math.round(g)));
    await this.setAgc(false);
    await this._in(REQ.SET_VGA_GAIN, 0, LIN_VGA[i], 1);
    await this._in(REQ.SET_MIXER_GAIN, 0, LIN_MIXER[i], 1);
    await this._in(REQ.SET_LNA_GAIN, 0, LIN_LNA[i], 1);
  }

  async setReceiverMode(on) {
    await this._out(REQ.RECEIVER_MODE, on ? 1 : 0, 0);
  }

  /**
   * Stream raw samples. onData(ArrayBuffer) gets little-endian uint16 real
   * samples at 2 x sampleRate (12-bit, offset 2048), in order.
   */
  async start(onData, onError) {
    if (this.streaming) return;
    await this.setReceiverMode(0);
    await this.dev.clearHalt("in", 1);
    await this.setReceiverMode(1);
    this.streaming = true;
    const run = ++this.run, live = () => this.streaming && this.run === run;
    const loop = async () => {
      while (live()) {
        let r;
        try {
          r = await this.dev.transferIn(1, TRANSFER_BYTES);
        } catch (e) {
          if (live()) { this.streaming = false; onError?.(e); }
          return;
        }
        if (!live()) return;
        if (r.status === "ok" && r.data && r.data.byteLength) {
          const v = r.data;
          const buf = v.byteOffset === 0 && v.byteLength === v.buffer.byteLength
            ? v.buffer : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
          onData(buf);
        } else if (r.status === "stall") {
          await this.dev.clearHalt("in", 1);
        }
      }
    };
    this._loops = Array.from({ length: TRANSFERS }, loop);
  }

  async stop() {
    if (!this.streaming) return;
    this.streaming = false;
    try { await this.setReceiverMode(0); } catch { /* unplugged */ }
    // Releasing the interface aborts the transfers still queued
    try { await this.dev.releaseInterface(0); await this.dev.claimInterface(0); } catch { /* unplugged */ }
    // The aborted transfers normally end at once; never wait forever for one the OS holds on to
    await Promise.race([Promise.allSettled(this._loops || []), new Promise((r) => setTimeout(r, 2000))]);
  }

  async _in(request, value, index, length) {
    const r = await this.dev.controlTransferIn(
      { requestType: "vendor", recipient: "device", request, value, index }, length);
    if (r.status !== "ok") throw new Error(`Airspy request ${request} failed: ${r.status}`);
    return r.data;
  }

  async _out(request, value, index, data) {
    const r = await this.dev.controlTransferOut(
      { requestType: "vendor", recipient: "device", request, value, index }, data);
    if (r.status !== "ok") throw new Error(`Airspy request ${request} failed: ${r.status}`);
  }
}

function decodeString(dv) {
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.subarray(0, end) : bytes).trim();
}

function hex32(v) {
  return v.toString(16).toUpperCase().padStart(8, "0");
}
