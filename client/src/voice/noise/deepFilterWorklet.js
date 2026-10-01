// DeepFilterNet 3 as an AudioWorklet (the "Strong" noise suppression; loaded by
// noiseStages.js): its own WebAssembly build (deepfilter/, see
// scripts/build-deepfilternet.sh), model included, on 10 ms frames at 48 kHz. Mono. Comes
// before the voice worklet, whose RNNoise then only decides the gate.
//
// processorOptions: { module: WebAssembly.Module, attenuation: dB (100: as much as it can) }.
// Messages in: { type: 'destroy' }. Out: { type: 'ready' } or { type: 'error', message }, and
// { type: 'slow' } once it has stepped aside because this device can't keep up (the audio
// then passes through; the voice worklet's RNNoise takes over).
import './workletPolyfills';
import { createReblocker } from './frames';
import {
  initSync, df_create_default as dfCreate, df_get_frame_length as dfFrameLength,
  df_process_frame as dfProcessFrame, df_destroy as dfDestroy,
} from './deepfilter/df.js';

// Too slow: frames taking over 80% of their own length on average, for three windows of a
// second running. (A glitch now and then, like a busy moment, doesn't count.)
const WINDOW_FRAMES = 100;
const SLOW_SHARE = 0.8;
const SLOW_WINDOWS = 3;
const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

class DeepFilterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { module, attenuation = 100 } = options.processorOptions ?? {};
    this.destroyed = false;
    this.reblock = null;
    this.state = 0;
    try {
      // One WebAssembly instance per AudioContext (initSync does nothing the second time),
      // one model state per node.
      initSync(module);
      this.state = dfCreate(attenuation);
      const frameSize = dfFrameLength(this.state);
      const budget = (frameSize / sampleRate) * 1000 * SLOW_SHARE * WINDOW_FRAMES;
      let spent = 0;
      let frames = 0;
      let slowWindows = 0;
      this.reblock = createReblocker(frameSize, (frame) => {
        const start = now();
        const out = dfProcessFrame(this.state, frame);
        spent += now() - start;
        if (++frames === WINDOW_FRAMES) {
          slowWindows = spent > budget ? slowWindows + 1 : 0;
          spent = 0;
          frames = 0;
          if (slowWindows >= SLOW_WINDOWS) {
            this.reblock = null;
            this.port.postMessage({ type: 'slow' });
          }
        }
        return out;
      });
      this.port.postMessage({ type: 'ready' });
    } catch (err) {
      // Without it the audio passes straight through.
      this.port.postMessage({ type: 'error', message: String(err?.message ?? err) });
    }
    this.port.onmessage = ({ data }) => {
      if (data?.type !== 'destroy' || this.destroyed) return;
      this.destroyed = true;
      if (this.state) dfDestroy(this.state);
      this.state = 0;
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
    if (this.reblock) this.reblock(input, output[0]);
    else output[0].set(input);
    for (let c = 1; c < output.length; c++) output[c].set(output[0]);
    return true;
  }
}

registerProcessor('voicaw-deepfilter', DeepFilterProcessor);
