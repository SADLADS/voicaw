// The voice worklet (AudioWorklet, loaded by noiseStages.js): RNNoise on every 10 ms frame,
// whose denoised audio is sent when noise suppression is Standard (otherwise the frame goes
// on as it came, and RNNoise only says whether it's speech), then the gate (gate.js). Mono.
//
// processorOptions: { rnnoise: WebAssembly.Module, denoise, gate: { auto, thresholdDb } }.
// Messages in: { type: 'options', denoise?, gate? }, { type: 'report', on } (send
// { type: 'level', db, open } every 50 ms, for the settings' meter), { type: 'destroy' }.
import { createReblocker, frameDb } from './frames';
import { createGate } from './gate';
import { createRnnoise } from './rnnoise';

const REPORT_EVERY = 5; // frames

class VoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { rnnoise, denoise = true, gate = {} } = options.processorOptions ?? {};
    this.denoise = denoise;
    this.reporting = false;
    this.frames = 0;
    this.destroyed = false;
    try {
      this.rnnoise = createRnnoise(rnnoise);
    } catch (err) {
      // Without it the audio passes straight through.
      this.rnnoise = null;
      this.port.postMessage({ type: 'error', message: String(err?.message ?? err) });
      return;
    }
    const frameSize = this.rnnoise.frameSize;
    this.gate = createGate({ frameSize, sampleRate });
    this.gate.setOptions(gate);
    const original = new Float32Array(frameSize);
    this.reblock = createReblocker(frameSize, (frame) => {
      original.set(frame);
      const speech = this.rnnoise.process(frame);
      const sent = this.denoise ? frame : original;
      const db = frameDb(sent);
      const out = this.gate.process(sent, speech, db);
      if (this.reporting && ++this.frames % REPORT_EVERY === 0) {
        this.port.postMessage({ type: 'level', db, open: this.gate.open });
      }
      return out;
    });
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'options') {
        if (typeof data.denoise === 'boolean') this.denoise = data.denoise;
        if (data.gate) this.gate.setOptions(data.gate);
      } else if (data?.type === 'report') {
        this.reporting = Boolean(data.on);
      } else if (data?.type === 'destroy') {
        this.destroyed = true;
        this.rnnoise?.destroy();
      }
    };
  }

  process(inputs, outputs) {
    if (this.destroyed) return false;
    const input = inputs[0]?.[0];
    const output = outputs[0];
    if (!output?.length) return true;
    if (!input) {
      for (const channel of output) channel.fill(0);
      return true;
    }
    if (this.rnnoise) this.reblock(input, output[0]);
    else output[0].set(input);
    for (let c = 1; c < output.length; c++) output[c].set(output[0]);
    return true;
  }
}

registerProcessor('voicaw-voice', VoiceProcessor);
