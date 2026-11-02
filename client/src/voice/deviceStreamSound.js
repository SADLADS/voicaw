// A screen share's sound in the desktop app on Linux (soundFrom 'device'): the app makes a
// virtual microphone carrying every other program's sound (electron/streamSound.js) and the page
// records it like a microphone, then publishes it as the share's sound. Found by its name, since
// device ids are the browser's own. It's never one of the microphones to choose in Settings.

export const STREAM_SOUND_LABEL = 'Voicaw stream sound';

export const isStreamSoundDevice = (device) => typeof device?.label === 'string' && device.label.startsWith(STREAM_SOUND_LABEL);

// Its sound, untouched (no echo cancellation, noise suppression or gain: it's not a voice).
export const STREAM_SOUND_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The microphone named `label`, recorded: a MediaStreamTrack. A new device can take the browser
// a moment to list, so it looks a few times. Throws if it never shows up.
export async function captureStreamSound({ label = STREAM_SOUND_LABEL, mediaDevices = navigator.mediaDevices, tries = 15, waitMs = 200 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const devices = await mediaDevices.enumerateDevices();
    const device = devices.find((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.label.startsWith(label));
    if (device) {
      const stream = await mediaDevices.getUserMedia({
        audio: { deviceId: { exact: device.deviceId }, ...STREAM_SOUND_CONSTRAINTS },
      });
      return stream.getAudioTracks()[0];
    }
    await sleep(waitMs);
  }
  throw new Error('The stream sound device never appeared');
}
