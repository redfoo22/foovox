/**
 * Microphone capture: downsample to 16 kHz and report loudness.
 *
 * Runs on the audio thread, so it keeps working while the main thread is busy
 * rendering the transcript. Two jobs:
 *
 *   1. Resample from the hardware rate (usually 48 kHz) to the 16 kHz Whisper
 *      wants. Asking for a 16 kHz AudioContext would be simpler but iOS
 *      quietly ignores the request and hands back 48 kHz anyway, and the
 *      mismatch is not visible until every transcript comes back as gibberish
 *      three times too fast.
 *   2. Emit an RMS level per block. Endpoint detection lives on the main
 *      thread, but the measurement has to happen where the samples are.
 */

const TARGET_RATE = 16000;
const FRAME = 320; // 20 ms at 16 kHz

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.tail = 0; // fractional carry, so blocks join without drift
    // The audio thread hands us 128 samples at a time — about 2.7 ms, or 375
    // messages a second. Batching to 20 ms frames cuts that to 50 without
    // costing anything the endpoint detector needs.
    this.pending = new Float32Array(FRAME);
    this.filled = 0;
    this.energy = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    // Linear resample. Speech at 16 kHz does not need anything fancier, and
    // an FIR here would cost more than it is worth on a phone.
    for (let pos = this.tail; pos < input.length; pos += this.ratio) {
      const a = Math.floor(pos);
      const frac = pos - a;
      const s0 = input[a];
      const s1 = a + 1 < input.length ? input[a + 1] : input[input.length - 1];
      const sample = s0 + (s1 - s0) * frac;

      this.pending[this.filled] = sample;
      this.energy += sample * sample;
      this.filled += 1;

      if (this.filled === FRAME) {
        const pcm = this.pending;
        this.port.postMessage({ pcm, rms: Math.sqrt(this.energy / FRAME) }, [pcm.buffer]);
        this.pending = new Float32Array(FRAME); // transferred; allocate the next
        this.filled = 0;
        this.energy = 0;
      }
    }
    // Carry the fractional position so consecutive blocks join without drift.
    this.tail = this.tail - input.length;
    while (this.tail < 0) this.tail += this.ratio;

    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
