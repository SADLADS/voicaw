import { useSyncExternalStore } from 'react';
import { getVoiceSnapshot, onVoiceChange } from '../voice/voiceClient';

// This device's voice connection (voice/voiceClient.js): { status, guildId, channelId,
// selfMute, selfDeaf, micTesting, canSpeak, speaking, error, micError, audioBlocked }.
export function useVoice() {
  return useSyncExternalStore(onVoiceChange, getVoiceSnapshot);
}
