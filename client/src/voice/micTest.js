import {
  captureOptions, getAudioSettings, inputGainStage, onAudioSettingsChange, outputSinkId,
} from './audioSettings';

// Settings → Voice & video's microphone test, like Discord's "Let's Check": the microphone as
// a call would send it (the chosen device and processing, at the input volume), drawn as a
// level and played back through the chosen speakers at the output volume. Volume and speaker
// changes apply as they're made; a new microphone or processing needs a new test (the
// settings page restarts it).

// 0–1 from a block of samples: its loudness, -60 dB (silence) to 0 dB.
export function levelOf(samples) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / (samples.length || 1));
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

// Starts the test; `onLevel(level)` is called every frame. Resolves to `stop()`. Rejects
// like getUserMedia (no microphone, not allowed).
export async function startMicTest({ onLevel, playback = true }) {
  const settings = getAudioSettings();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: captureOptions(settings) });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const gain = inputGainStage(context);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(gain.input);
  gain.output.connect(analyser);

  let audio = null;
  if (playback) {
    const destination = context.createMediaStreamDestination();
    gain.output.connect(destination);
    audio = new Audio();
    audio.srcObject = destination.stream;
    audio.volume = settings.outputVolume;
    if (outputSinkId() && audio.setSinkId) await audio.setSinkId(outputSinkId()).catch(() => {});
    audio.play().catch(() => {});
  }

  const stopListening = onAudioSettingsChange((next, previous) => {
    if (!audio) return;
    audio.volume = next.outputVolume;
    if (next.outputDeviceId !== previous.outputDeviceId && audio.setSinkId) {
      audio.setSinkId(outputSinkId(next)).catch(() => {});
    }
  });

  const samples = new Float32Array(analyser.fftSize);
  let frame = requestAnimationFrame(function tick() {
    analyser.getFloatTimeDomainData(samples);
    onLevel(levelOf(samples));
    frame = requestAnimationFrame(tick);
  });

  return function stop() {
    cancelAnimationFrame(frame);
    stopListening();
    gain.destroy();
    if (audio) {
      audio.pause();
      audio.srcObject = null;
    }
    for (const track of stream.getTracks()) track.stop();
    context.close().catch(() => {});
    onLevel(0);
  };
}
