import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import deepFilterWasmUrl from './deepfilter/df_bg.wasm?url';
import voiceWorkletUrl from './voiceWorklet.js?worker&url';
import deepFilterWorkletUrl from './deepFilterWorklet.js?worker&url';
import { gateOptions, getAudioSettings, onAudioSettingsChange } from '../audioSettings';
import { isMobileDevice } from '../../utils/presence';

// Noise suppression and the gate as a voice chain stage (voiceChain.js), on this device, with
// nothing sent anywhere: RNNoise and the gate in one worklet (voiceWorklet.js), and before it
// DeepFilterNet (deepFilterWorklet.js) when noise suppression is Strong. The WebAssembly is
// ours (served with the app, loaded on first use: RNNoise ~150 KB, DeepFilterNet ~17 MB);
// each worklet module is added once per AudioContext. Anything that fails to load leaves
// the audio as it was (and a failed DeepFilterNet falls back to RNNoise), so the microphone
// never goes silent over it. Needs a 48 kHz AudioContext (VOICE_SAMPLE_RATE).

export const VOICE_SAMPLE_RATE = 48000;
const DEEPFILTER_TIMEOUT_MS = 15000;

// The smallest module using a SIMD instruction (as wasm-feature-detect checks).
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);
const hasSimd = () => {
  try {
    return typeof WebAssembly !== 'undefined' && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
};
const hasAudioWorklet = () => typeof AudioWorkletNode !== 'undefined';

// Whether this device can do Standard (RNNoise) and Strong (DeepFilterNet: computers only,
// for the processor time, battery and download).
export const canSuppressNoise = () => hasAudioWorklet();
export const canSuppressStrongly = () => hasAudioWorklet() && hasSimd() && !isMobileDevice();

// Set when DeepFilterNet couldn't keep up on this device (it then steps aside for RNNoise
// until the page reloads); Settings says so.
let deepFilterSlow = false;
const slowListeners = new Set();
export const isDeepFilterSlow = () => deepFilterSlow;
export function onDeepFilterSlow(listener) {
  slowListeners.add(listener);
  return () => slowListeners.delete(listener);
}

const modules = new Map();
function loadModule(url) {
  if (!modules.has(url)) {
    const promise = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
        return response.arrayBuffer();
      })
      .then((bytes) => WebAssembly.compile(bytes));
    promise.catch(() => modules.delete(url));
    modules.set(url, promise);
  }
  return modules.get(url);
}

const workletModules = new WeakMap();
function addWorklet(context, url) {
  let added = workletModules.get(context);
  if (!added) workletModules.set(context, (added = new Map()));
  if (!added.has(url)) {
    const promise = context.audioWorklet.addModule(url);
    promise.catch(() => added.delete(url));
    added.set(url, promise);
  }
  return added.get(url);
}

const mono = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' };

// The gate's settings reach every running voice worklet at once (no rebuild).
const voiceNodes = new Set();
onAudioSettingsChange((next) => {
  for (const node of voiceNodes) node.port.postMessage({ type: 'options', gate: gateOptions(next) });
});

async function createVoiceNode(context, { denoise, gate }) {
  const [rnnoise] = await Promise.all([
    loadModule(hasSimd() ? rnnoiseSimdWasmUrl : rnnoiseWasmUrl),
    addWorklet(context, voiceWorkletUrl),
  ]);
  const node = new AudioWorkletNode(context, 'voicaw-voice', { ...mono, processorOptions: { rnnoise, denoise, gate } });
  voiceNodes.add(node);
  return node;
}

async function createDeepFilterNode(context) {
  const [module] = await Promise.all([loadModule(deepFilterWasmUrl), addWorklet(context, deepFilterWorkletUrl)]);
  const node = new AudioWorkletNode(context, 'voicaw-deepfilter', { ...mono, processorOptions: { module, attenuation: 100 } });
  // The model loads inside the worklet; wait to hear it did.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DeepFilterNet took too long to start')), DEEPFILTER_TIMEOUT_MS);
    node.port.onmessage = ({ data }) => {
      if (data?.type === 'ready') {
        clearTimeout(timer);
        resolve();
      } else if (data?.type === 'error') {
        clearTimeout(timer);
        reject(new Error(data.message));
      }
    };
  });
  return node;
}

function destroyNode(node) {
  if (!node) return;
  node.port.postMessage({ type: 'destroy' });
  node.port.onmessage = null;
  node.disconnect();
  voiceNodes.delete(node);
}

// The stage: `voiceProcessingStage(context, { settings, onLevel })`. `onLevel(db, open)`, if
// given, is called every 50 ms with the level the gate sees and whether it's open (the
// settings' meter).
export async function voiceProcessingStage(context, { settings = getAudioSettings(), onLevel } = {}) {
  const passthrough = () => {
    const node = context.createGain();
    return { input: node, output: node };
  };
  if (!canSuppressNoise()) return passthrough();
  const mode = settings.noiseSuppression;

  let deepFilter = null;
  if (mode === 'strong' && canSuppressStrongly() && !deepFilterSlow) {
    deepFilter = await createDeepFilterNode(context).catch((err) => {
      console.warn('Strong noise suppression unavailable, using Standard', err);
      return null;
    });
  }

  let voice;
  try {
    voice = await createVoiceNode(context, {
      // RNNoise denoises for Standard, and for Strong when DeepFilterNet isn't there.
      denoise: mode === 'standard' || (mode === 'strong' && !deepFilter),
      gate: gateOptions(settings),
    });
  } catch (err) {
    console.warn('Noise suppression unavailable', err);
    if (!deepFilter) return passthrough();
    return { input: deepFilter, output: deepFilter, destroy: () => destroyNode(deepFilter) };
  }

  voice.port.onmessage = ({ data }) => {
    if (data?.type === 'level') onLevel?.(data.db, data.open);
  };
  if (onLevel) voice.port.postMessage({ type: 'report', on: true });

  if (deepFilter) {
    deepFilter.port.onmessage = ({ data }) => {
      if (data?.type !== 'slow') return;
      console.warn('DeepFilterNet is too slow on this device, using Standard noise suppression');
      voice.port.postMessage({ type: 'options', denoise: true });
      if (!deepFilterSlow) {
        deepFilterSlow = true;
        for (const listener of slowListeners) listener();
      }
    };
    deepFilter.connect(voice);
  }

  return {
    input: deepFilter ?? voice,
    output: voice,
    destroy() {
      destroyNode(deepFilter);
      destroyNode(voice);
    },
  };
}
