// RNNoise (Xiph's small recurrent network) from @sapphi-red/web-noise-suppressor's build of it
// (Shiguredo's, with and without SIMD), driven directly: the package's own worklet throws away
// the speech probability RNNoise gives each frame, which the gate needs. The WebAssembly only
// asks for three Emscripten helpers, so it's instantiated here without Emscripten's loader
// (which an AudioWorklet couldn't run anyway).
//
// `createRnnoise(module)` (a compiled WebAssembly.Module) → { frameSize, process(frame) →
// speech probability, destroy() }: `process` denoises a frame of 480 samples (-1..1, 48 kHz)
// in place.
export function createRnnoise(module) {
  let memory = null;
  let heapF32 = null;
  const views = () => {
    if (!heapF32 || heapF32.buffer !== memory.buffer) heapF32 = new Float32Array(memory.buffer);
    return heapF32;
  };
  const instance = new WebAssembly.Instance(module, {
    env: {
      emscripten_memcpy_big: (dest, src, num) => {
        new Uint8Array(memory.buffer).copyWithin(dest, src, src + num);
      },
      emscripten_resize_heap: (requested) => {
        const pages = Math.ceil((requested - memory.buffer.byteLength) / 65536);
        try {
          memory.grow(pages);
          return 1;
        } catch {
          return 0;
        }
      },
      __assert_fail: () => {
        throw new Error('RNNoise assertion failed');
      },
    },
  });
  const wasm = instance.exports;
  memory = wasm.memory;
  wasm.emscripten_stack_init?.();
  wasm.__wasm_call_ctors?.();

  const frameSize = wasm.rnnoise_get_frame_size();
  const state = wasm.rnnoise_create(0);
  const input = wasm.malloc(frameSize * 4);
  const output = wasm.malloc(frameSize * 4);
  if (!state || !input || !output) throw new Error('RNNoise could not allocate its state');
  let destroyed = false;

  return {
    frameSize,
    process(frame) {
      if (destroyed) return 0;
      const heap = views();
      const inAt = input / 4;
      // RNNoise works on 16-bit sample values.
      for (let i = 0; i < frameSize; i++) heap[inAt + i] = frame[i] * 32767;
      const speech = wasm.rnnoise_process_frame(state, output, input);
      const after = views();
      const outAt = output / 4;
      for (let i = 0; i < frameSize; i++) frame[i] = after[outAt + i] / 32767;
      return speech;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      wasm.rnnoise_destroy(state);
      wasm.free(input);
      wasm.free(output);
    },
  };
}
