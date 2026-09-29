// The microphone's processing chain, as a LiveKit audio processor: the mic (already through
// the browser's echo cancellation, noise suppression and gain control) → each stage in turn →
// what's sent. LiveKit rebuilds it when the mic changes (restart).
//
// A stage is `(audioContext) => { input: AudioNode, output: AudioNode, destroy?() }` (input
// and output can be the same node). Voice isolation (RNNoise, DeepFilterNet: an
// AudioWorkletNode each) goes in as a stage; with none, the audio passes through unchanged.
export function createVoiceChain(stages = []) {
  let nodes = null;
  // LiveKit only passes the AudioContext to init, not to restart (after an unmute, when the
  // mic was released, or a mic change).
  let context = null;

  const processor = {
    name: 'voicaw-voice-chain',
    processedTrack: undefined,

    async init({ track, audioContext }) {
      context = audioContext ?? context;
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const built = stages.map((stage) => stage(context));
      const destination = context.createMediaStreamDestination();
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
      await processor.destroy();
      await processor.init(options);
    },

    async destroy() {
      if (!nodes) return;
      nodes.source.disconnect();
      for (const stage of nodes.built) {
        stage.output.disconnect();
        stage.destroy?.();
      }
      processor.processedTrack?.stop();
      processor.processedTrack = undefined;
      nodes = null;
    },
  };
  return processor;
}
