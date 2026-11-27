/**
 * AudioWorklet processors running off the main thread for T3 real-time assistant:
 * 1) `t3-lipsync-processor`: Goertzel formant-band analyzer emitting 5-vowel
 *    viseme weights `{ a, i, u, e, o, silence }` at ~60Hz with zero external WASM.
 * 2) `t3-vad-processor`: Adaptive noise-floor speech-band VAD emitting low-latency
 *    `speech_start` / `speech_end` events for <=80ms barge-in interruption.
 */

function goertzelPower(samples, freqHz, sampleRate) {
  const n = samples.length;
  if (n === 0 || sampleRate <= 0) return 0;
  const omega = (2 * Math.PI * freqHz) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.max(0, power) / (n * n);
}

class T3LipSyncProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(512);
    this._offset = 0;
    this._framesSinceEmit = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (input && output) {
      output.set(input);
    }
    if (!input) return true;

    for (let i = 0; i < input.length; i += 1) {
      this._buffer[this._offset] = input[i];
      this._offset += 1;
      if (this._offset >= this._buffer.length) {
        this._offset = 0;
        this._framesSinceEmit += 1;
        // At 48kHz, 512 samples ~ 10.6ms -> emit every 2 windows (~47-60Hz)
        if (this._framesSinceEmit >= 2) {
          this._framesSinceEmit = 0;
          this._analyzeAndPost();
        }
      }
    }
    return true;
  }

  _analyzeAndPost() {
    const buf = this._buffer;
    let sumSq = 0;
    for (let i = 0; i < buf.length; i += 1) {
      sumSq += buf[i] * buf[i];
    }
    const rms = Math.sqrt(sumSq / buf.length);
    if (rms < 0.012) {
      this.port.postMessage({
        type: "viseme",
        weights: { a: 0, i: 0, u: 0, e: 0, o: 0, silence: 1 },
      });
      return;
    }

    const sr = sampleRate || 48000;
    // Key F1/F2 vowel formant probes (Hz)
    const e300 = Math.sqrt(goertzelPower(buf, 320, sr)); // /u/, /i/ F1
    const e500 = Math.sqrt(goertzelPower(buf, 500, sr)); // /o/, /e/ F1
    const e750 = Math.sqrt(goertzelPower(buf, 750, sr)); // /a/ F1
    const e1100 = Math.sqrt(goertzelPower(buf, 1100, sr)); // /a/, /o/ F2
    const e1900 = Math.sqrt(goertzelPower(buf, 1900, sr)); // /e/ F2
    const e2400 = Math.sqrt(goertzelPower(buf, 2400, sr)); // /i/ F2

    const gain = Math.min(1, rms * 7.5);
    const rawA = e750 * 0.7 + e1100 * 0.5;
    const rawI = e300 * 0.4 + e2400 * 0.9;
    const rawU = e300 * 0.85 + e500 * 0.25;
    const rawE = e500 * 0.45 + e1900 * 0.75;
    const rawO = e500 * 0.75 + e1100 * 0.45;
    const norm = Math.max(1e-5, rawA + rawI + rawU + rawE + rawO);

    this.port.postMessage({
      type: "viseme",
      weights: {
        a: Math.min(1, (rawA / norm) * gain * 1.9),
        i: Math.min(1, (rawI / norm) * gain * 1.9),
        u: Math.min(1, (rawU / norm) * gain * 1.9),
        e: Math.min(1, (rawE / norm) * gain * 1.9),
        o: Math.min(1, (rawO / norm) * gain * 1.9),
        silence: Math.max(0, 1 - gain),
      },
    });
  }
}

class T3VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._noiseFloor = 0.015;
    this._speaking = false;
    this._speechFrames = 0;
    this._silenceFrames = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    let sumSq = 0;
    let zeroCrossings = 0;
    for (let i = 0; i < input.length; i += 1) {
      const v = input[i];
      sumSq += v * v;
      if (i > 0 && ((v >= 0 && input[i - 1] < 0) || (v < 0 && input[i - 1] >= 0))) {
        zeroCrossings += 1;
      }
    }
    const rms = Math.sqrt(sumSq / input.length);
    const zcr = zeroCrossings / input.length;

    // Adapt background noise floor slowly only when silent
    if (!this._speaking) {
      this._noiseFloor = this._noiseFloor * 0.985 + Math.min(rms, 0.04) * 0.015;
    }

    const threshold = Math.max(0.022, this._noiseFloor * 2.6);
    const speechLike = rms > threshold && zcr >= 0.01 && zcr <= 0.35;

    if (speechLike) {
      this._speechFrames += 1;
      this._silenceFrames = 0;
      // ~15-25ms hysteresis (6-8 render quanta of 128 samples at 48kHz)
      if (!this._speaking && this._speechFrames >= 6) {
        this._speaking = true;
        this.port.postMessage({ type: "speech_start", rms });
      }
    } else {
      this._silenceFrames += 1;
      this._speechFrames = 0;
      // ~550ms silence to finalize utterance (~200 render quanta at 48kHz)
      if (this._speaking && this._silenceFrames >= 200) {
        this._speaking = false;
        this.port.postMessage({ type: "speech_end" });
      }
    }
    return true;
  }
}

registerProcessor("t3-lipsync-processor", T3LipSyncProcessor);
registerProcessor("t3-vad-processor", T3VadProcessor);
