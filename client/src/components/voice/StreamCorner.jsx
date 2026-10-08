import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useVoice } from '../../hooks/useVoice';
import { useCall } from '../../hooks/useCall';
import { useStreamWindow } from '../../hooks/useStreamWindow';
import { useStreamOnPage } from '../../hooks/useStreamOnPage';
import { displayName, useProfiles } from '../../utils/profiles';
import StreamView from './StreamView';
import { t } from '../../i18n';

// Someone else's screen share you're watching, small in a corner while no page shows it (you
// went to another channel or conversation), as Watch Together's player does: it keeps playing,
// with its volume, a way back to its channel or call, pop out and stop watching. Drawn from
// Layout. Not your own stream, nor one popped out into its own window.
export default function StreamCorner() {
  useProfiles();
  const navigate = useNavigate();
  const voice = useVoice();
  const call = useCall();
  const poppedOut = useStreamWindow() != null;
  const onPage = useStreamOnPage();
  const { watching } = voice;
  if (watching == null || watching === voice.identity || poppedOut || onPage) return null;

  let to;
  if (voice.callId != null) to = call?.groupId ? `/dm/g/${call.groupId}` : call?.peerId ? `/dm/${call.peerId}` : null;
  else if (voice.guildId != null) to = `/guild/${voice.guildId}/${voice.channelId}`;
  return (
    <StreamView
      key={watching}
      userId={watching}
      name={displayName(watching)}
      own={false}
      corner
      onOpen={to ? () => navigate(to) : undefined}
      openLabel={voice.callId != null ? t('voice.stream.openCall') : t('voice.stream.openChannel')}
    />
  );
}
