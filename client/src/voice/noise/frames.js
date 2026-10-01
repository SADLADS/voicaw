// Audio worklets get 128 samples at a time; RNNoise and DeepFilterNet work on frames of 480
// (10 ms at 48 kHz). `createReblocker(frameSize, processFrame)` returns `(input, output)` to
// call with each block: it collects input into frames, hands each to `processFrame(frame)`
// (which returns the processed frame, the same length; it may reuse its buffers), and fills
// `output` from what's been processed. The output starts one frame of silence behind, which
// is just enough that it never runs dry whatever the block size (as long as it's at most a
// frame).
export function createReblocker(frameSize, processFrame) {
  const frame = new Float32Array(frameSize);
  let filled = 0;
  const capacity = frameSize * 2 + 1024;
  const ring = new Float32Array(capacity);
  let read = 0;
  let write = frameSize; // primed with a frame of zeros
  return (input, output) => {
    for (let i = 0; i < input.length; i++) {
      frame[filled++] = input[i];
      if (filled === frameSize) {
        filled = 0;
        const processed = processFrame(frame);
        for (let j = 0; j < frameSize; j++) {
          ring[write] = processed[j];
          write = (write + 1) % capacity;
        }
      }
    }
    for (let i = 0; i < output.length; i++) {
      output[i] = ring[read];
      read = (read + 1) % capacity;
    }
  };
}

// A frame's loudness in dBFS (-100 for silence).
export function frameDb(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / (frame.length || 1));
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}
