import { useEffect, useRef } from 'react';
import { desktop } from '../utils/desktop';
import { overlayVoiceState } from '../utils/overlay';
import { avatarUrl, displayName, useProfiles } from '../utils/profiles';
import { voiceTitle } from '../utils/voiceTitle';
import { useVoice } from './useVoice';
import { useCall } from './useCall';

// The desktop app's in-game overlay (from Layout): tells the app who's in the voice channel or
// call you're in, and who's talking, whenever that changes (the app decides whether to show
// it: electron/overlay.js). Nothing in a browser, or in a copy of the app without an overlay.
export function useGameOverlay({ user, guildList, groupList }) {
  useProfiles();
  const voice = useVoice();
  const call = useCall();
  const sent = useRef(undefined);
  const channelMembers = voice.guildId != null
    ? guildList.layouts[voice.guildId]?.channels.find((c) => c.id === voice.channelId)?.voice ?? null
    : null;
  const state = desktop?.setOverlayVoice && overlayVoiceState(voice, {
    title: voice.status === 'idle' ? '' : voiceTitle({ voice, call, guildList, groupList, user }),
    channelMembers,
    name: displayName,
    avatar: avatarUrl,
  });
  const key = desktop?.setOverlayVoice ? JSON.stringify(state) : null;

  useEffect(() => {
    if (!desktop?.setOverlayVoice || key === sent.current) return;
    sent.current = key;
    desktop.setOverlayVoice(JSON.parse(key));
  }, [key]);

  // Logged out: not in voice.
  useEffect(() => () => {
    if (sent.current) desktop?.setOverlayVoice?.(null);
    sent.current = undefined;
  }, []);
}
