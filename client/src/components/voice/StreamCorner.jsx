import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useVoice } from '../../hooks/useVoice';
import { useCall } from '../../hooks/useCall';
import { useStreamWindow } from '../../hooks/useStreamWindow';
import { useStreamOnPage } from '../../hooks/useStreamOnPage';
import { displayName, useProfiles } from '../../utils/profiles';
import StreamView from './StreamView';
import { cornerOf } from '../../voice/stage';
import { useCornerClaim } from '../../services/cornerSlot';
import { participantName } from '../../voice/voiceClient';
import { t } from '../../i18n';

// Someone else's screen share you're watching or camera you've focused, small in a corner while
// no page shows it (you went to another channel or conversation), as Watch Together's player
// does: it keeps playing,
// with its volume, a way back to its channel or call, pop out and stop watching. Drawn from
// Layout. Not your own stream, nor one popped out into its own window, nor while another
// player has the corner (services/cornerSlot.js; it comes once that's gone).
export default function StreamCorner() {
  useProfiles();
  const navigate = useNavigate();
  const voice = useVoice();
  const call = useCall();
  const poppedOut = useStreamWindow() != null;
  const onPage = useStreamOnPage();
  const shown = cornerOf(voice);
  const wants = shown != null && !poppedOut && !onPage;
  // One player in the corner at a time: while another has it, the stream keeps its sound only.
  const granted = useCornerClaim('stream', wants);
  if (!wants || !granted) return null;

  let to;
  if (voice.callId != null) to = call?.groupId ? `/dm/g/${call.groupId}` : call?.peerId ? `/dm/${call.peerId}` : null;
  else if (voice.guildId != null) to = `/guild/${voice.guildId}/${voice.channelId}`;
  return (
    <StreamView
      key={`${shown.kind}-${shown.id}`}
      userId={shown.id}
      name={displayName(shown.id, participantName(shown.id))}
      own={false}
      camera={shown.kind === 'camera'}
      corner
      onOpen={to ? () => navigate(to) : undefined}
      openLabel={voice.callId != null ? t('voice.stream.openCall') : t('voice.stream.openChannel')}
    />
  );
}
