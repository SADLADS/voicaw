import { groupTitle } from './groupDisplay';
import { displayName } from './profiles';
import { t } from '../i18n';

// What you're in voice with, as the voice bar shows it and the Android app's ongoing-call
// notification: "Call with Sam", "Call in Weekend", "General / Our guild".
export function voiceTitle({ voice, call, guildList, groupList, user }) {
  if (voice.callId != null) {
    if (call?.groupId) {
      const group = groupList.groups.find((g) => g.id === call.groupId);
      return t('voice.bar.callInGroup', { name: groupTitle(group ?? { name: t('voice.bar.aGroup') }, user) });
    }
    return call ? t('voice.bar.callWith', { name: displayName(call.peerId, call.peerName) }) : t('voice.bar.call');
  }
  const guild = guildList.layouts[voice.guildId] ?? guildList.guilds.find((g) => g.id === voice.guildId);
  const channel = guildList.layouts[voice.guildId]?.channels.find((c) => c.id === voice.channelId);
  const channelName = channel?.name ?? t('voice.bar.voice');
  return guild ? t('voice.bar.channelInGuild', { channel: channelName, guild: guild.name }) : channelName;
}
