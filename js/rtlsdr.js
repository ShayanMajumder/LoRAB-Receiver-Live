// RTL-SDR (RTL2832U with an R820T, R820T2 or R828D tuner) driver over WebUSB.
//
// Mirrors librtlsdr (rtl-sdr-blog fork: librtlsdr.c and tuner_r82xx.c): the
// same registers written in the same order. Covers the common dongles,
// including the RTL-SDR Blog V3 and V4.
//   Linux:   needs a udev rule, and the DVB-T kernel driver must not claim it.
//   Windows: the dongle must use the WinUSB driver (Zadig), as for any SDR app.
//   macOS, ChromeOS, Android (OTG): works as is.

// Known RTL2832U dongles (librtlsdr known_devices)
export const RTL_IDS = [[0x0bda, 0x2832], [0x0bda, 0x2838], [0x0413, 0x6680], [0x0413, 0x6f0f], [0x0458, 0x707f],
  [0x0ccd, 0x00a9], [0x0ccd, 0x00b3], [0x0ccd, 0x00b4], [0x0ccd, 0x00b5], [0x0ccd, 0x00b7], [0x0ccd, 0x00b8],
  [0x0ccd, 0x00b9], [0x0ccd, 0x00c0], [0x0ccd, 0x00c6], [0x0ccd, 0x00d3], [0x0ccd, 0x00d7], [0x0ccd, 0x00e0],
  [0x1554, 0x5020], [0x15f4, 0x0131], [0x15f4, 0x0133], [0x185b, 0x0620], [0x185b, 0x0650], [0x185b, 0x0680],
  [0x1b80, 0xd393], [0x1b80, 0xd394], [0x1b80, 0xd395], [0x1b80, 0xd397], [0x1b80, 0xd398], [0x1b80, 0xd39d],
  [0x1b80, 0xd3a4], [0x1b80, 0xd3a8], [0x1b80, 0xd3af], [0x1b80, 0xd3b0], [0x1d19, 0x1101], [0x1d19, 0x1102],
  [0x1d19, 0x1103], [0x1d19, 0x1104], [0x1f4d, 0xa803], [0x1f4d, 0xb803], [0x1f4d, 0xc803], [0x1f4d, 0xd286],
  [0x1f4d, 0xd803]];

const RTL_XTAL = 28800000;
const TWO_POW_22 = 4194304;
const BLOCK = { DEMOD: 0, USB: 1, SYS: 2, IIC: 6 };
const USB_SYSCTL = 0x2000, USB_EPA_CTL = 0x2148, USB_EPA_MAXPKT = 0x2158;
const DEMOD_CTL = 0x3000, GPO = 0x3001, GPOE = 0x3003, GPD = 0x3004, DEMOD_CTL_1 = 0x300b;
const FIR_DEFAULT = [-54, -36, -41, -40, -32, -14, 14, 53, 101, 156, 215, 273, 327, 372, 404, 421];

const TRANSFER_BYTES = 16 * 32 * 512;     // librtlsdr DEFAULT_BUF_LENGTH
const TRANSFERS = 8;

// ------------------------------------------------------------------ R82xx tuner
const R820T_ADDR = 0x34, R828D_ADDR = 0x74, R82XX_CHECK_VAL = 0x69;
const REG_SHADOW_START = 5, NUM_REGS = 30, VER_NUM = 49, R82XX_IF_FREQ = 3570000;
const R82XX_INIT = [0x83, 0x32, 0x75, 0xc0, 0x40, 0xd6, 0x6c, 0xf5, 0x63, 0x75, 0x68, 0x6c, 0x83, 0x80,
  0x00, 0x0f, 0x00, 0xc0, 0x30, 0x48, 0xcc, 0x60, 0x00, 0x54, 0xae, 0x4a, 0xc0];
// [start MHz, open_d, rf_mux_ploy, tf_c, xtal_cap20p, xtal_cap10p, xtal_cap0p]
const FREQ_RANGES = [[0, 0x08, 0x02, 0xdf, 0x02, 0x01, 0x00], [50, 0x08, 0x02, 0xbe, 0x02, 0x01, 0x00],
  [55, 0x08, 0x02, 0x8b, 0x02, 0x01, 0x00], [60, 0x08, 0x02, 0x7b, 0x02, 0x01, 0x00],
  [65, 0x08, 0x02, 0x69, 0x02, 0x01, 0x00], [70, 0x08, 0x02, 0x58, 0x02, 0x01, 0x00],
  [75, 0x00, 0x02, 0x44, 0x02, 0x01, 0x00], [80, 0x00, 0x02, 0x44, 0x02, 0x01, 0x00],
  [90, 0x00, 0x02, 0x34, 0x01, 0x01, 0x00], [100, 0x00, 0x02, 0x34, 0x01, 0x01, 0x00],
  [110, 0x00, 0x02, 0x24, 0x01, 0x01, 0x00], [120, 0x00, 0x02, 0x24, 0x01, 0x01, 0x00],
  [140, 0x00, 0x02, 0x14, 0x01, 0x01, 0x00], [180, 0x00, 0x02, 0x13, 0x00, 0x00, 0x00],
  [220, 0x00, 0x02, 0x13, 0x00, 0x00, 0x00], [250, 0x00, 0x02, 0x11, 0x00, 0x00, 0x00],
  [280, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00], [310, 0x00, 0x41, 0x00, 0x00, 0x00, 0x00],
  [450, 0x00, 0x41, 0x00, 0x00, 0x00, 0x00], [588, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00],
  [650, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00]];
const LNA_STEPS = [0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13];
const MIXER_STEPS = [0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8];
const IF_LOW_PASS_BW = [1700000, 1600000, 1550000, 1450000, 1200000, 900000, 700000, 550000, 450000, 350000];
const FILT_HP_BW1 = 350000, FILT_HP_BW2 = 380000;
const MAX_GAIN_TENTHS = 496;
const MAX_IF_BW = 2400000;

const bitrev = (b) => {
  const lut = [0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf];
  return (lut[b & 0xf] << 4) | lut[b >> 4];
};

class R82xx {
  constructor(rtl, addr, isR828D, xtal) {
    this.rtl = rtl;
    this.addr = addr;
    this.isR828D = isR828D;
    this.xtal = xtal;
    this.regs = new Uint8Array(NUM_REGS);
    this.intFreq = R82XX_IF_FREQ;
    this.input = 0;
    this.hasLock = false;
    this.filCal = 0;
  }

  async write(reg, vals) {
    const r = reg - REG_SHADOW_START;
    if (r >= 0 && r + vals.length <= NUM_REGS && vals.every((v, i) => this.regs[r + i] === v)) return;
    vals.forEach((v, i) => { if (r + i >= 0 && r + i < NUM_REGS) this.regs[r + i] = v; });
    for (let pos = 0; pos < vals.length; pos += 7) {           // max_i2c_msg_len 8
      const chunk = vals.slice(pos, pos + 7);
      await this.rtl.i2cWrite(this.addr, [reg + pos, ...chunk]);
    }
  }

  writeReg(reg, val) {
    return this.write(reg, [val & 0xff]);
  }

  writeRegMask(reg, val, mask) {
    const old = this.regs[reg - REG_SHADOW_START];
    return this.write(reg, [((old & ~mask) | (val & mask)) & 0xff]);
  }

  async read(reg, len) {
    await this.rtl.i2cWrite(this.addr, [reg]);
    return Array.from(await this.rtl.i2cRead(this.addr, len), bitrev);
  }

  async setMux(freq) {
    const mhz = Math.floor(freq / 1e6);
    let i = 0;
    while (i < FREQ_RANGES.length - 1 && mhz >= FREQ_RANGES[i + 1][0]) i++;
    const [, openD, rfMux, tfC, , , cap0p] = FREQ_RANGES[i];
    await this.writeRegMask(0x17, openD, 0x08);
    await this.writeRegMask(0x1a, rfMux, 0xc3);
    await this.writeReg(0x1b, tfC);
    await this.writeRegMask(0x10, cap0p | 0x00, 0x0b);         // XTAL_HIGH_CAP_0P
    await this.writeRegMask(0x08, 0x00, 0x3f);
    await this.writeRegMask(0x09, 0x00, 0x3f);
  }

  async setPll(freq) {
    const freqKhz = Math.floor((freq + 500) / 1000), pllRef = this.xtal;
    const vcoMin = 1770000, vcoMax = 2 * vcoMin;
    await this.writeRegMask(0x1a, 0x00, 0x0c);                 // PLL autotune 128 kHz
    const regs = Array.from(this.regs.subarray(0x10 - REG_SHADOW_START, 0x10 - REG_SHADOW_START + 7));
    const m = (r, v, mask) => ((r & ~mask) | (v & mask)) & 0xff;
    regs[0] = m(regs[0], 0, 0x10);                             // refdiv2 = 0
    regs[2] = m(regs[2], 0x80, 0xe0);                          // VCO current 100
    let mixDiv = 2, divNum = 0;
    while (mixDiv <= 64) {
      if (freqKhz * mixDiv >= vcoMin && freqKhz * mixDiv < vcoMax) {
        for (let b = mixDiv; b > 2; b >>= 1) divNum++;
        break;
      }
      mixDiv <<= 1;
    }
    const data = await this.read(0x00, 5);
    const vcoPowerRef = this.isR828D ? 1 : 2, fine = (data[4] & 0x30) >> 4;
    if (fine > vcoPowerRef) divNum = (divNum - 1) & 0xff;
    else if (fine < vcoPowerRef) divNum = (divNum + 1) & 0xff;
    regs[0] = m(regs[0], divNum << 5, 0xe0);
    const vcoDiv = Math.floor((pllRef + 65536 * freq * mixDiv) / (2 * pllRef));
    const nint = Math.floor(vcoDiv / 65536), sdm = vcoDiv % 65536;
    if (nint > 128 / vcoPowerRef - 1) throw new Error(`No valid PLL values for ${freq} Hz`);
    const ni = Math.floor((nint - 13) / 4), si = nint - 4 * ni - 13;
    regs[4] = (ni + (si << 6)) & 0xff;
    regs[2] = m(regs[2], sdm === 0 ? 0x08 : 0x00, 0x08);       // pw_sdm
    regs[5] = sdm & 0xff;
    regs[6] = sdm >> 8;
    await this.write(0x10, regs);
    let lock = [];
    for (let i = 0; i < 2; i++) {
      lock = await this.read(0x00, 3);
      if (lock[2] & 0x40) break;
      if (!i) await this.writeRegMask(0x12, 0x60, 0xe0);       // Not locked: more VCO current
    }
    this.hasLock = !!(lock[2] & 0x40);
    if (this.hasLock) await this.writeRegMask(0x1a, 0x08, 0x08); // PLL autotune 8 kHz
  }

  async setTvStandard() {
    const hpCor = 0x6b, filtQ = 0x10;
    this.regs.set(R82XX_INIT);
    await this.writeRegMask(0x0c, 0x00, 0x0f);
    await this.writeRegMask(0x13, VER_NUM, 0x3f);
    await this.writeRegMask(0x1d, 0x00, 0x38);
    this.intFreq = R82XX_IF_FREQ;
    for (let i = 0; i < 2; i++) {                              // Filter calibration
      await this.writeRegMask(0x0b, hpCor, 0x60);
      await this.writeRegMask(0x0f, 0x04, 0x04);
      await this.writeRegMask(0x10, 0x00, 0x03);
      await this.setPll(56000 * 1000);
      if (!this.hasLock) return;                               // As librtlsdr
      await this.writeRegMask(0x0b, 0x10, 0x10);
      await this.writeRegMask(0x0b, 0x00, 0x10);
      await this.writeRegMask(0x0f, 0x00, 0x04);
      const data = await this.read(0x00, 5);
      this.filCal = data[4] & 0x0f;
      if (this.filCal && this.filCal !== 0x0f) break;
    }
    if (this.filCal === 0x0f) this.filCal = 0;
    await this.writeRegMask(0x0a, filtQ | this.filCal, 0x1f);
    await this.writeRegMask(0x0b, hpCor, 0xef);
    await this.writeRegMask(0x07, 0x00, 0x80);
    await this.writeRegMask(0x06, 0x10, 0x30);
    await this.writeRegMask(0x1e, 0x60, 0x60);
    await this.writeRegMask(0x05, 0x01, 0x80);
    await this.writeRegMask(0x1f, 0x00, 0x80);
    await this.writeRegMask(0x0f, 0x00, 0x80);
    await this.writeRegMask(0x19, 0x60, 0x60);
  }

  async sysfreqSel() {
    const mixerTop = 0x24;
    await this.writeRegMask(0x1d, 0xe5, 0xc7);
    await this.writeRegMask(0x1c, mixerTop, 0xf8);
    await this.writeReg(0x0d, 0x53);
    await this.writeReg(0x0e, 0x75);
    this.input = 0x00;
    await this.writeRegMask(0x05, 0x00, 0x60);
    await this.writeRegMask(0x06, 0x00, 0x08);
    await this.writeRegMask(0x11, 0x38, 0x38);
    await this.writeRegMask(0x17, 0x30, 0x30);
    await this.writeRegMask(0x0a, 0x40, 0x60);
    await this.writeRegMask(0x1d, 0, 0x38);
    await this.writeRegMask(0x1c, 0, 0x04);
    await this.writeRegMask(0x06, 0, 0x40);
    await this.writeRegMask(0x1a, 0x30, 0x30);
    await this.writeRegMask(0x1d, 0x18, 0x38);
    await this.writeRegMask(0x1c, mixerTop, 0x04);
    await this.writeRegMask(0x1e, 14, 0x1f);
    await this.writeRegMask(0x1a, 0x20, 0x30);
  }

  async init() {
    this.regs.fill(0);
    await this.write(0x05, R82XX_INIT);
    await this.setTvStandard();
    await this.sysfreqSel();
  }

  /** gainTenths < 0: automatic. */
  async setGain(gainTenths) {
    if (gainTenths >= 0) {
      await this.writeRegMask(0x05, 0x10, 0x10);               // LNA auto off
      await this.writeRegMask(0x07, 0, 0x10);                  // Mixer auto off
      await this.read(0x00, 4);
      await this.writeRegMask(0x0c, 0x08, 0x9f);               // Fixed VGA 16.3 dB
      let total = 0, lna = 0, mix = 0;
      for (let i = 0; i < 15; i++) {
        if (total >= gainTenths) break;
        total += LNA_STEPS[++lna];
        if (total >= gainTenths) break;
        total += MIXER_STEPS[++mix];
      }
      await this.writeRegMask(0x05, lna, 0x0f);
      await this.writeRegMask(0x07, mix, 0x0f);
    } else {
      await this.writeRegMask(0x05, 0, 0x10);                  // LNA auto
      await this.writeRegMask(0x07, 0x10, 0x10);               // Mixer auto
      await this.writeRegMask(0x0c, 0x0b, 0x9f);               // Fixed VGA 26.5 dB
    }
  }

  async setBandwidth(bw) {
    let reg0a, reg0b, realBw = 0;
    if (bw > 7000000) { reg0a = 0x10; reg0b = 0x0b; this.intFreq = 4570000; }
    else if (bw > 6000000) { reg0a = 0x10; reg0b = 0x2a; this.intFreq = 4570000; }
    else if (bw > IF_LOW_PASS_BW[0] + FILT_HP_BW1 + FILT_HP_BW2) { reg0a = 0x10; reg0b = 0x6b; this.intFreq = 3570000; }
    else {
      reg0a = 0x00;
      reg0b = 0x80;
      this.intFreq = 2300000;
      if (bw > IF_LOW_PASS_BW[0] + FILT_HP_BW1) { bw -= FILT_HP_BW2; this.intFreq += FILT_HP_BW2; realBw += FILT_HP_BW2; }
      else reg0b |= 0x20;
      if (bw > IF_LOW_PASS_BW[0]) { bw -= FILT_HP_BW1; this.intFreq += FILT_HP_BW1; realBw += FILT_HP_BW1; }
      else reg0b |= 0x40;
      let i = 0;
      while (i < IF_LOW_PASS_BW.length && !(bw > IF_LOW_PASS_BW[i])) i++;
      i--;
      reg0b |= 15 - i;
      realBw += IF_LOW_PASS_BW[i];
      this.intFreq -= Math.floor(realBw / 2);
    }
    await this.writeRegMask(0x0a, reg0a, 0x10);
    await this.writeRegMask(0x0b, reg0b, 0xef);
    return this.intFreq;
  }

  async setFreq(freq, isV4) {
    const lo = freq + this.intFreq;
    await this.setMux(lo);
    await this.setPll(lo);
    if (!this.hasLock) console.warn(`[RTL-SDR] PLL not locked at ${freq} Hz`);
    if (isV4) {
      // RTL-SDR Blog V4: notch filters off inside the FM/DAB bands, then pick the input for the band
      const off = freq <= 2.2e6 || (freq >= 85e6 && freq <= 112e6) || (freq >= 172e6 && freq <= 242e6);
      await this.writeRegMask(0x17, off ? 0x00 : 0x08, 0x08);
      const band = freq <= 28.8e6 ? 1 : freq < 250e6 ? 2 : 3;
      if (band !== this.input) {
        this.input = band;
        const cable2 = band === 1 ? 0x08 : 0x00;
        await this.writeRegMask(0x06, cable2, 0x08);
        await this.rtl.setGpioOutput(5);
        await this.rtl.setGpioBit(5, !cable2);
        await this.writeRegMask(0x05, band === 2 ? 0x40 : 0x00, 0x40);
        await this.writeRegMask(0x05, band === 3 ? 0x00 : 0x20, 0x20);
      }
    } else if (this.isR828D) {
      const air = freq > 345e6 ? 0x00 : 0x60;
      if (air !== this.input) {
        this.input = air;
        await this.writeRegMask(0x05, air, 0x60);
      }
    }
  }

  async standby() {
    for (const [r, v] of [[0x06, 0xb1], [0x05, 0xa0], [0x07, 0x3a], [0x08, 0x40], [0x09, 0xc0], [0x0a, 0x36],
      [0x0c, 0x35], [0x0f, 0x68], [0x11, 0x03], [0x17, 0xf4], [0x19, 0x0c]]) await this.writeReg(r, v);
  }
}

// ------------------------------------------------------------------ RTL2832U
export class RtlSdr {
  static filters = RTL_IDS.map(([vendorId, productId]) => ({ vendorId, productId }));

  static matches(d) {
    return RTL_IDS.some(([v, p]) => d.vendorId === v && d.productId === p);
  }

  constructor(device) {
    this.dev = device;
    this.format = "rtl";                 // uint8 I/Q pairs
    this.streaming = false;
    this.run = 0;                        // Streaming session; transfer loops of an older one exit
    this.sampleRates = [2000000, 2250000];   // 2.5 MS/s gave symbol errors in tests; 3 MS/s drops samples
    this.sampleRate = 0;
    this.frequency = 0;
  }

  async open() {
    const d = this.dev;
    if (!d.opened) await d.open();
    if (!d.configuration || d.configuration.configurationValue !== 1) await d.selectConfiguration(1);
    await d.claimInterface(0);
    try { await this.writeReg(BLOCK.USB, USB_SYSCTL, 0x09, 1); } catch { await d.reset(); }
    await this.initBaseband();
    await this.setI2cRepeater(true);
    let addr = R820T_ADDR, r828d = false;
    if ((await this.i2cReadReg(R820T_ADDR, 0x00)) !== R82XX_CHECK_VAL) {
      if ((await this.i2cReadReg(R828D_ADDR, 0x00)) !== R82XX_CHECK_VAL) {
        await this.setI2cRepeater(false);
        throw new Error("Unsupported RTL-SDR tuner: only R820T, R820T2 and R828D dongles are supported");
      }
      addr = R828D_ADDR;
      r828d = true;
    }
    this.isV4 = d.manufacturerName === "RTLSDRBlog" && d.productName === "Blog V4";
    const tunerXtal = r828d && !this.isV4 ? 16000000 : RTL_XTAL;
    await this.demodWriteReg(1, 0xb1, 0x1a, 1);               // Zero-IF off
    await this.demodWriteReg(0, 0x08, 0x4d, 1);               // In-phase ADC only
    await this.setIfFreq(R82XX_IF_FREQ);
    await this.demodWriteReg(1, 0x15, 0x01, 1);               // Spectrum inversion
    this.tuner = new R82xx(this, addr, r828d, tunerXtal);
    await this.tuner.init();
    await this.setI2cRepeater(false);
    this.model = this.isV4 ? "RTL-SDR Blog V4" : `RTL-SDR ${r828d ? "R828D" : "R820T"}`;
    this.serial = d.serialNumber || "";
    return this;
  }

  get name() {
    return this.serial ? `${this.model} (SN ${this.serial})` : this.model;
  }

  async close() {
    await this.stop();
    try {
      await this.setI2cRepeater(true);
      await this.tuner?.standby();
      await this.setI2cRepeater(false);
      await this.writeReg(BLOCK.SYS, DEMOD_CTL, 0x20, 1);    // Power off demod and ADCs
    } catch { /* unplugged */ }
    try { await this.dev.releaseInterface(0); } catch { /* already released */ }
    try { await this.dev.close(); } catch { /* already closed */ }
  }

  async initBaseband() {
    await this.writeReg(BLOCK.USB, USB_SYSCTL, 0x09, 1);
    await this.writeReg(BLOCK.USB, USB_EPA_MAXPKT, 0x0002, 2);
    await this.writeReg(BLOCK.USB, USB_EPA_CTL, 0x1002, 2);
    await this.writeReg(BLOCK.SYS, DEMOD_CTL_1, 0x22, 1);
    await this.writeReg(BLOCK.SYS, DEMOD_CTL, 0xe8, 1);
    await this.demodWriteReg(1, 0x01, 0x14, 1);
    await this.demodWriteReg(1, 0x01, 0x10, 1);
    await this.demodWriteReg(1, 0x15, 0x00, 1);
    await this.demodWriteReg(1, 0x16, 0x0000, 2);
    for (let i = 0; i < 6; i++) await this.demodWriteReg(1, 0x16 + i, 0x00, 1);
    await this.setFir();
    await this.demodWriteReg(0, 0x19, 0x05, 1);               // SDR mode, no DAGC
    await this.demodWriteReg(1, 0x93, 0xf0, 1);
    await this.demodWriteReg(1, 0x94, 0x0f, 1);
    await this.demodWriteReg(1, 0x11, 0x00, 1);
    await this.demodWriteReg(1, 0x04, 0x00, 1);
    await this.demodWriteReg(0, 0x61, 0x60, 1);
    await this.demodWriteReg(0, 0x06, 0x80, 1);
    await this.demodWriteReg(1, 0xb1, 0x1b, 1);
    await this.demodWriteReg(0, 0x0d, 0x83, 1);
  }

  async setFir() {
    const fir = new Array(20);
    for (let i = 0; i < 8; i++) fir[i] = FIR_DEFAULT[i] & 0xff;
    for (let i = 0; i < 8; i += 2) {
      const v0 = FIR_DEFAULT[8 + i], v1 = FIR_DEFAULT[8 + i + 1], o = 8 + (i * 3) / 2;
      fir[o] = (v0 >> 4) & 0xff;
      fir[o + 1] = ((v0 << 4) | ((v1 >> 8) & 0x0f)) & 0xff;
      fir[o + 2] = v1 & 0xff;
    }
    for (let i = 0; i < fir.length; i++) await this.demodWriteReg(1, 0x1c + i, fir[i], 1);
  }

  async setIfFreq(freq) {
    const ifFreq = -Math.floor((freq * TWO_POW_22) / RTL_XTAL);
    await this.demodWriteReg(1, 0x19, (ifFreq >> 16) & 0x3f, 1);
    await this.demodWriteReg(1, 0x1a, (ifFreq >> 8) & 0xff, 1);
    await this.demodWriteReg(1, 0x1b, ifFreq & 0xff, 1);
  }

  async setSampleRate(rate) {
    if (!this.sampleRates.includes(rate)) throw new Error(`Unsupported sample rate ${rate}`);
    const ratio = Math.floor((RTL_XTAL * TWO_POW_22) / rate) & 0x0ffffffc;
    // The tuner's IF filter follows the sample rate, and so does the IF. Capped at 2.4 MHz:
    // wider filters switch the R820T to a 3.57 MHz IF with ~6 dB less signal at the
    // 8-bit ADC, which measured 6 dB more FM noise in the tag's band.
    await this.setI2cRepeater(true);
    const intFreq = await this.tuner.setBandwidth(Math.min(rate, MAX_IF_BW));
    await this.setIfFreq(intFreq);
    if (this.frequency) await this.tuner.setFreq(this.frequency, this.isV4);
    await this.setI2cRepeater(false);
    await this.demodWriteReg(1, 0x9f, ratio >> 16, 2);
    await this.demodWriteReg(1, 0xa1, ratio & 0xffff, 2);
    await this.demodWriteReg(1, 0x3f, 0, 1);                  // No ppm correction
    await this.demodWriteReg(1, 0x3e, 0, 1);
    await this.demodWriteReg(1, 0x01, 0x14, 1);
    await this.demodWriteReg(1, 0x01, 0x10, 1);
    this.sampleRate = rate;
  }

  async setFrequency(hz) {
    hz = Math.round(hz);
    await this.setI2cRepeater(true);
    await this.tuner.setFreq(hz, this.isV4);
    await this.setI2cRepeater(false);
    this.frequency = hz;
  }

  /** Automatic tuner gain (LNA + mixer AGC, fixed VGA). */
  async setAgc(on) {
    if (!on) return;
    await this.setI2cRepeater(true);
    await this.tuner.setGain(-1);
    await this.setI2cRepeater(false);
  }

  /** Manual gain 0..21 (same scale as the Airspy), mapped onto the R820T's 0..49.6 dB. */
  async setLinearityGain(g) {
    await this.setI2cRepeater(true);
    await this.tuner.setGain(Math.round((Math.max(0, Math.min(21, g)) / 21) * MAX_GAIN_TENTHS));
    await this.setI2cRepeater(false);
  }

  /** onData(ArrayBuffer): uint8 I/Q pairs at sampleRate, in order. */
  async start(onData, onError) {
    if (this.streaming) return;
    await this.writeReg(BLOCK.USB, USB_EPA_CTL, 0x1002, 2);   // Reset the buffer
    await this.writeReg(BLOCK.USB, USB_EPA_CTL, 0x0000, 2);
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
          onData(v.byteOffset === 0 && v.byteLength === v.buffer.byteLength
            ? v.buffer : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
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
    try { await this.dev.releaseInterface(0); await this.dev.claimInterface(0); } catch { /* unplugged */ }
    // The aborted transfers normally end at once; never wait forever for one the OS holds on to
    await Promise.race([Promise.allSettled(this._loops || []), new Promise((r) => setTimeout(r, 2000))]);
  }

  // -------------------------------------------------------------- register access (librtlsdr)
  async readArray(block, addr, len) {
    const r = await this.dev.controlTransferIn(
      { requestType: "vendor", recipient: "device", request: 0, value: addr, index: block << 8 }, len);
    if (r.status !== "ok") throw new Error(`RTL-SDR read ${block}:${addr} failed: ${r.status}`);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  async writeArray(block, addr, bytes) {
    const r = await this.dev.controlTransferOut(
      { requestType: "vendor", recipient: "device", request: 0, value: addr, index: (block << 8) | 0x10 },
      Uint8Array.from(bytes));
    if (r.status !== "ok") throw new Error(`RTL-SDR write ${block}:${addr} failed: ${r.status}`);
  }

  async readReg(block, addr, len) {
    const d = await this.readArray(block, addr, len);
    return len === 2 ? (d[1] << 8) | d[0] : d[0];
  }

  writeReg(block, addr, val, len) {
    return this.writeArray(block, addr, len === 1 ? [val & 0xff] : [(val >> 8) & 0xff, val & 0xff]);
  }

  async demodWriteReg(page, addr, val, len) {
    const data = len === 1 ? [val & 0xff] : [(val >> 8) & 0xff, val & 0xff];
    const r = await this.dev.controlTransferOut(
      { requestType: "vendor", recipient: "device", request: 0, value: (addr << 8) | 0x20, index: 0x10 | page },
      Uint8Array.from(data));
    if (r.status !== "ok") throw new Error(`RTL-SDR demod write ${page}:${addr} failed: ${r.status}`);
    await this.dev.controlTransferIn(
      { requestType: "vendor", recipient: "device", request: 0, value: (0x01 << 8) | 0x20, index: 0x0a }, 1);
  }

  setI2cRepeater(on) {
    return this.demodWriteReg(1, 0x01, on ? 0x18 : 0x10, 1);
  }

  i2cWrite(addr, bytes) {
    return this.writeArray(BLOCK.IIC, addr, bytes);
  }

  i2cRead(addr, len) {
    return this.readArray(BLOCK.IIC, addr, len);
  }

  async i2cReadReg(addr, reg) {
    await this.writeArray(BLOCK.IIC, addr, [reg]);
    return (await this.readArray(BLOCK.IIC, addr, 1))[0];
  }

  async setGpioOutput(gpio) {
    const bit = 1 << gpio;
    await this.writeReg(BLOCK.SYS, GPD, (await this.readReg(BLOCK.SYS, GPD, 1)) & ~bit, 1);
    await this.writeReg(BLOCK.SYS, GPOE, (await this.readReg(BLOCK.SYS, GPOE, 1)) | bit, 1);
  }

  async setGpioBit(gpio, on) {
    const bit = 1 << gpio, r = await this.readReg(BLOCK.SYS, GPO, 1);
    await this.writeReg(BLOCK.SYS, GPO, on ? r | bit : r & ~bit, 1);
  }
}
