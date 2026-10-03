import React, { useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../../assets/css/guilds.css';
import { LayoutContext } from '../../contexts';
import GuildIcon from './GuildIcon';
import { acceptInvite, fetchInvitePreview, invitePreviewRequested } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { usePrivacyPrefs } from '../../utils/privacy';
import { t } from '../../i18n';

// The card under a message with an invite link: the guild's picture and name, and Join Guild
// (or Go to Guild when you're already in it).
// `autoLoad` false (encrypted chats): the server would learn which invite someone was sent
// just by the card asking about it, so it only asks once tapped, unless Settings → Privacy
// says to load them anyway (utils/privacy).
export default function InviteEmbed({ code, autoLoad = true }) {
  const navigate = useNavigate();
  const guildList = useContext(LayoutContext)?.guildList;
  const loadAnyway = usePrivacyPrefs().inviteEmbedsInEncrypted;
  const [shown, setShown] = useState(() => invitePreviewRequested(code));
  const load = autoLoad || loadAnyway || shown;
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState(null);

  useEffect(() => {
    if (!load) return undefined;
    let cancelled = false;
    setInvite(null);
    setError(null);
    fetchInvitePreview(code)
      .then((data) => { if (!cancelled) setInvite(data); })
      .catch((err) => { if (!cancelled) setError(err); });
    return () => {
      cancelled = true;
    };
  }, [code, load]);

  // Membership from the guild list, so the button changes as soon as you join or leave.
  const isMember = invite && (guildList?.loaded
    ? guildList.guilds.some((g) => g.id === invite.guild_id)
    : invite.is_member);

  async function join() {
    setJoining(true);
    setJoinError(null);
    try {
      const guild = await acceptInvite(code);
      guildList?.upsertGuild(guild);
      navigate(`/guild/${guild.id}`);
    } catch (err) {
      setJoinError(errorMessage(err));
    } finally {
      setJoining(false);
    }
  }

  let icon;
  let title;
  let hint;
  let button = null;
  if (!load) {
    icon = <span className="guild-icon guild-initials invite-embed-icon" aria-hidden="true">?</span>;
    title = t('guilds.invite.embed.title');
    hint = t('guilds.invite.embed.tapShow');
    button = <button type="button" className="btn btn-secondary" onClick={() => setShown(true)}>{t('guilds.invite.embed.show')}</button>;
  } else if (error) {
    const invalid = error?.response?.status === 404;
    icon = <span className="guild-icon guild-initials invite-embed-icon invite-embed-invalid" aria-hidden="true">✕</span>;
    title = invalid ? t('guilds.invite.embed.invalid') : t('guilds.invite.embed.loadFailed');
    hint = invalid ? t('guilds.invite.embed.invalidHint') : errorMessage(error);
  } else if (!invite) {
    icon = <span className="guild-icon guild-initials invite-embed-icon" aria-hidden="true" />;
    title = t('guilds.invite.loading');
  } else {
    icon = <GuildIcon guild={{ id: invite.guild_id, name: invite.name, icon_version: invite.icon_version }} className="invite-embed-icon" />;
    title = invite.name;
    hint = joinError ?? t('guilds.invite.memberCount', { count: invite.member_count });
    button = isMember ? (
      <button type="button" className="btn btn-secondary" onClick={() => navigate(`/guild/${invite.guild_id}`)}>{t('guilds.invite.embed.goTo')}</button>
    ) : (
      <button type="button" className="btn btn-primary invite-embed-join" onClick={join} disabled={joining}>{t('guilds.invite.embed.join')}</button>
    );
  }

  return (
    <div className="invite-embed">
      <div className="invite-embed-label">{t('guilds.invite.embed.label')}</div>
      <div className="invite-embed-body">
        {icon}
        <div className="invite-embed-text">
          <div className="invite-embed-name">{title}</div>
          {hint ? <div className={`invite-embed-hint${joinError ? ' invite-embed-error' : ''}`}>{hint}</div> : null}
        </div>
        {button}
      </div>
    </div>
  );
}
