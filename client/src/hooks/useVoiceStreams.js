import { useSyncExternalStore } from 'react';
import { getVoiceStreamsVersion, streamOf, subscribeVoiceStreams } from '../utils/voiceStreams';

// Re-renders when someone starts or stops sharing their screen in guild voice; returns
// `streamOf(userId)` (utils/voiceStreams.js).
export function useVoiceStreams() {
  useSyncExternalStore(subscribeVoiceStreams, getVoiceStreamsVersion);
  return streamOf;
}
