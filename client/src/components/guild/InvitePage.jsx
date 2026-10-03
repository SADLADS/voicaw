import React, { useContext, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import '../../assets/css/guilds.css';
import { LayoutContext } from '../../contexts';
import GuildIcon from './GuildIcon';
import { acceptInvite, fetchInvite } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { t } from '../../i18n';

// /invite/:code: who invited you to which guild, and a button to join (or open it, if
// you're already in).
export default function InvitePage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const { guildList } = useContext(LayoutContext);
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setInvite(null);
    setError(null);
    fetchInvite(code)
      .then((data) => { if (!cancelled) setInvite(data); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); });
    return () => {
      cancelled = true;
    };
  }, [code]);

  async function join() {
    setJoining(true);
    try {
      const guild = await acceptInvite(code);
      guildList.upsertGuild(guild);
      navigate(`/guild/${guild.id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setJoining(false);
    }
  }

  return (
    <div className="invite-page">
      <div className="invite-card">
        {error ? (
          <>
            <h5>{t('guilds.invite.page.invalid')}</h5>
            <p className="vc-hint">{error}</p>
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/dm')}>{t('guilds.invite.page.back')}</button>
          </>
        ) : !invite ? (
          <p className="vc-hint">{t('guilds.invite.loading')}</p>
        ) : (
          <>
            <GuildIcon guild={{ id: invite.guild_id, name: invite.name, icon_version: invite.icon_version }} className="invite-icon" />
            <p className="vc-hint">{t('guilds.invite.page.invitedBy', { name: invite.creator_username })}</p>
            <h4>{invite.name}</h4>
            <p className="vc-hint">{t('guilds.invite.memberCount', { count: invite.member_count })}</p>
            {invite.is_member ? (
              <button type="button" className="btn btn-primary vc-button" onClick={() => navigate(`/guild/${invite.guild_id}`)}>
                {t('guilds.invite.page.goTo')}
              </button>
            ) : (
              <button type="button" className="btn btn-primary vc-button" onClick={join} disabled={joining}>
                {t('guilds.invite.page.accept')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
