// Picks the driver for a USB radio: Airspy (R2, Mini) or RTL-SDR (RTL2832U + R820T/R828D).
// Both drivers share one interface: open, close, name, sampleRates, setSampleRate,
// setFrequency, setAgc, setLinearityGain, start, stop, and `format` for the raw samples.

import { Airspy } from "./airspy.js";
import { RtlSdr } from "./rtlsdr.js";

const DRIVERS = [Airspy, RtlSdr];

function wrap(device) {
  const D = DRIVERS.find((d) => d.matches(device));
  return D ? new D(device) : null;
}

/** Shows the browser's device chooser, listing every supported radio. */
export async function requestRadio(usb = globalThis.navigator?.usb) {
  return wrap(await usb.requestDevice({ filters: DRIVERS.flatMap((d) => d.filters) }));
}

/** A radio the user already granted to this site, or null. Prefers an Airspy. */
export async function pairedRadio(usb = globalThis.navigator?.usb) {
  const devs = await usb.getDevices();
  for (const D of DRIVERS) {
    const d = devs.find((x) => D.matches(x));
    if (d) return new D(d);
  }
  return null;
}

export function isRadio(device) {
  return DRIVERS.some((d) => d.matches(device));
}
