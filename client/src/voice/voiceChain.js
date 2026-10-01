// The microphone's processing chain, as a LiveKit audio processor: the mic (already through
// the browser's echo cancellation and gain control) → each stage in turn → what's sent.
// LiveKit rebuilds it when the mic changes (restart).
//
// A stage is `(audioContext) => { input: AudioNode, output: AudioNode, destroy?() }`, or a
// promise of one (input and output can be the same node). Ours are the input volume and the
// noise suppression and gate (noise/noiseStages.js); with none, the audio passes through
// unchanged. `stages` can be a function returning the list, called on every (re)build, so a
// rebuild picks up changed settings.
//
// `sampleRate`: the rate the stages need (RNNoise and DeepFilterNet only work at 48 kHz).
// LiveKit's AudioContext runs at the device's rate, often 44.1 kHz; then the chain runs in an
// AudioContext of its own at that rate (the browser resamples the mic into it and back out).
export function createVoiceChain(stages = [], { sampleRate } = {}) {
  let nodes = null;
  // LiveKit only passes the AudioContext to init, not to restart (after an unmute, when the
  // mic was released, or a mic change).
  let context = null;
  let ownContext = null;

  const contextFor = (given) => {
    if (!sampleRate || given.sampleRate === sampleRate) return given;
    if (!ownContext || ownContext.state === 'closed') {
      ownContext = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    }
    return ownContext;
  };

  const teardown = () => {
    if (!nodes) return;
    nodes.source.disconnect();
    for (const stage of nodes.built) {
      stage.output.disconnect();
      stage.destroy?.();
    }
    processor.processedTrack?.stop();
    processor.processedTrack = undefined;
    nodes = null;
  };

  const processor = {
    name: 'voicaw-voice-chain',
    processedTrack: undefined,

    async init({ track, audioContext }) {
      context = audioContext ?? context;
      const ctx = contextFor(context);
      if (ctx.state === 'suspended') ctx.resume?.().catch(() => {});
      const list = typeof stages === 'function' ? stages() : stages;
      const built = [];
      for (const stage of list) built.push(await stage(ctx));
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const destination = ctx.createMediaStreamDestination();
      let last = source;
      for (const stage of built) {
        last.connect(stage.input);
        last = stage.output;
      }
      last.connect(destination);
      nodes = { source, built, destination };
      processor.processedTrack = destination.stream.getAudioTracks()[0];
    },

    async restart(options) {
      teardown();
      await processor.init(options);
    },

    async destroy() {
      teardown();
      if (ownContext) {
        ownContext.close().catch(() => {});
        ownContext = null;
      }
    },
  };
  return processor;
}
