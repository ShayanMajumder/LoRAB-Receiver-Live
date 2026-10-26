// Per-station processing, run in its own worker (station-worker.js) so
// stations decode in parallel. Talks to the radio worker over a port:
//   in:  start {fs, centerHz, stations:[{idx, freq}], cfg, demoOffset?, audio?, deemph?}
//        iq {seq, iq}          wideband IQ block
//        tick {seq, n}         demo: generate n channel samples
//        audio {on, deemph}    mono audio of station 0 (the main station)
//        stop
//   out: bb {seq, outs:[{idx, bb}], busy}   baseband blocks at the chirp bandwidth
//        rds {idx, freq, ps, pi}
//        audio {pcm}           50 kHz mono samples

import { StationChain, RdsDecoder, CHANNEL_RATE } from "./dsp.js";
import { DemoChannel, demoStation } from "./demo.js";

export class StationCore {
  constructor(port) {
    this.port = port;
    this.chains = [];
    port.onmessage = ({ data }) => this.handle(data);
  }

  handle(m) {
    try {
      this._handle(m);
    } catch (e) {
      this.port.postMessage({ type: "error", message: e.message });   // The radio worker skips the block
    }
  }

  _handle(m) {
    const t0 = performance.now();
    switch (m.type) {
      case "start": {
        const rate = m.cfg.chanRate || CHANNEL_RATE;
        this.chains = m.stations.map((s) => {
          const c = new StationChain({ fs: m.fs, offsetHz: s.freq - m.centerHz, bw: m.cfg.bw,
            subcarrierHz: m.cfg.subcarrier, chanRate: rate });
          c.idx = s.idx;
          c.freq = s.freq;
          if (m.demoOffset !== undefined) {
            c.demo = new DemoChannel(s.freq, m.cfg, m.demoOffset);
            c.demoName = demoStation(s.freq)?.name;
            c.demoSamples = 0;
          } else {
            c.rds = new RdsDecoder((r) => this.port.postMessage({ type: "rds", idx: s.idx, freq: s.freq, ...r }), rate);
          }
          return c;
        });
        this.setAudio(m.audio, m.deemph);
        break;
      }
      case "audio":
        this.setAudio(m.on, m.deemph);
        break;
      case "iq":
        this.reply(m.seq, this.chains.map((c) => c.process(m.iq)), t0);
        break;
      case "tick":
        this.reply(m.seq, this.chains.map((c) => {
          // The demo has no RDS signal; report its name after a realistic delay
          if (c.demoName && (c.demoSamples += m.n) > 1.5 * c.rate && !c.named) {
            c.named = true;
            this.port.postMessage({ type: "rds", idx: c.idx, freq: c.freq, ps: c.demoName, pi: null });
          }
          return c.processChannel(c.demo.next(m.n));
        }), t0);
        break;
      case "stop":
        this.chains = [];
        break;
    }
  }

  setAudio(on, deemph = 50e-6) {
    const main = this.chains.find((c) => c.idx === 0);
    main?.setAudio(!!on, deemph, (pcm) => this.port.postMessage({ type: "audio", pcm }, [pcm.buffer]));
  }

  reply(seq, blocks, t0) {
    const outs = blocks.map((b, i) => ({ idx: this.chains[i].idx, bb: b.slice() }));
    this.port.postMessage({ type: "bb", seq, outs, busy: performance.now() - t0 }, outs.map((o) => o.bb.buffer));
  }
}
