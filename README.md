# LoRAB Receiver

**Open it: https://shayanmajumder.github.io/LoRAB-Receiver-Live/**

Receive messages from a LoRAB ambient-backscatter tag with an Airspy, right in
your browser. The tag hides its messages in the FM radio stations around it;
this page finds the stations, finds the tag and decodes it. There is nothing
to install.

## Use it

1. Open the page in **Chrome or Edge** (desktop or Android).
2. Plug in the **Airspy** (R2 or Mini) with an FM antenna.
3. Press **Start**. The first time, Chrome asks which device to use: pick **AIRSPY**.

That's it. The page scans the FM band, checks every station for the tag,
and starts listening on the best one. Next time it starts by itself as soon as
the Airspy is plugged in.

No Airspy? Press **Try the demo**: it simulates a radio and a tag.

### What you see

- **Latest message** from the tag, with its signal strength.
- **Spectrum** of the captured band, with the station in use and the helper
  stations it is combined with.
- **Tag chirps**: the tag's signal, live. A frame starts with 8 falling and 3
  rising chirps.
- **Packets**: every frame received. Click one to see its symbols and how many
  errors were corrected.
- **Play audio** plays the station you are listening to (mono).

### If it doesn't connect

| | |
|---|---|
| Firefox, Safari | Not supported (no WebUSB). Use Chrome or Edge. |
| Linux | Allow access to the Airspy once, then replug it (command below). |
| Windows | The Airspy needs the WinUSB driver: the official Airspy driver, or WinUSB installed with [Zadig](https://zadig.akeo.ie/). |
| macOS, ChromeOS, Android | Nothing to install. |
| "in use by another program" | Close GNU Radio, SDR++, SDR# or another tab using the Airspy. |

Linux access rule:

```bash
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="1d50", ATTRS{idProduct}=="60a1", MODE="0666"' | sudo tee /etc/udev/rules.d/52-airspy.rules
sudo udevadm control --reload-rules
```

## Settings

Everything is under **Settings** (top right): bandwidth and gain, the tag's
spreading factor, chirp bandwidth, subcarrier and frame timing, how many
stations and frames to combine, audio de-emphasis, and a noise test that adds
noise to check the decoder at a chosen SNR. The tag settings must match the
tag's firmware; **Copy firmware settings** gives the matching lines.

## How it works

The page drives the Airspy over WebUSB (the same USB requests as libairspy)
and does all the signal processing in JavaScript Web Workers, one per station
on separate CPU cores:

- Each FM station is demodulated.
- The tag's chirps are taken from the 43–53 kHz part of the FM multiplex.
- Frames are found and soft-decoded (rate-1/3 convolutional code, list
  Viterbi, CRC).
- Frames are combined across stations and across repeats. This decodes down
  to about −22 dB SNR.

The tag firmware (MYOSA / ESP32), the GNU Radio receiver and the research code
are in the [LoRAB repository](https://github.com/daskals/LoRAB-Long-Range-Ambient-Backscatter).

## Updating this site

This repository is a published copy of `Receiver/web-receiver` in the LoRAB
repository. After changing it there, from the LoRAB repository's folder:

```bash
rsync -a --delete --exclude .git --exclude README.md --exclude .nojekyll Receiver/web-receiver/ LoRAB-Receiver-Live/
cd LoRAB-Receiver-Live && git add -A && git commit -m "Update receiver" && git push
```

GitHub Pages republishes within a minute or two.
