import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DeveloperPage from './DeveloperPage';
import PermissionChecklist from './PermissionChecklist';
import Avatar from '../Avatar';
import { answerLogin, authorize, fetchAuthorization, fetchLogin, rememberBots } from '../../services/developerService';
import { useAuth } from '../../hooks/useAuth';
import { BOT_PERMISSIONS, canGrant, fromBitfield, toBitfield } from '../../utils/botPermissions';
import { errorMessage } from '../../utils/guildDisplay';
import { displayName, nameOf, useProfiles } from '../../utils/profiles';
import { t } from '../../i18n';

// The scopes a login link asks for (server/oauth.js); anything else is a bot invite.
const isBotInvite = (scope) => {
  const scopes = (scope ?? '').split(/[\s+]+/).filter(Boolean);
  return !scopes.length || scopes.includes('bot');
};

// Sends the page to the site (`location`, from the server: one of the application's redirect URIs).
function goTo(location, setLeaving) {
  setLeaving(new URL(location).host);
  window.location.assign(location);
}

// /oauth2/authorize, as Discord's: a bot's invite link (scope=bot), or a website's "Login with
// Voicaw" link (scope=identify, response_type=code, redirect_uri, state).
export default function AuthorizePage() {
  const [params] = useSearchParams();
  return isBotInvite(params.get('scope')) ? <BotInvite /> : <LoginConsent />;
}

// Login with Voicaw: the application, who made it, what it'll know about you and where you'll
// go; Authorise sends you back to the site with a code, Cancel with access_denied. A link with
// prompt=none goes straight back if you've let it in before (as Discord's). A link with an
// unknown application or redirect URI never sends anyone anywhere.
function LoginConsent() {
  useProfiles();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const me = useAuth()?.user;
  const request = useMemo(() => Object.fromEntries(
    ['client_id', 'response_type', 'scope', 'redirect_uri', 'state']
      .filter((key) => params.has(key))
      .map((key) => [key, params.get(key)])
  ), [params]);
  const prompt = params.get('prompt');
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [leaving, setLeaving] = useState(null); // the host we're sending you to

  const leave = (location) => goTo(location, setLeaving);

  const answer = async (deny) => {
    setError(null);
    try {
      leave((await answerLogin(request, deny)).location);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetchLogin(request)
      .then(async (data) => {
        if (cancelled) return;
        rememberBots([data], [data.owner]);
        if (data.authorized && prompt === 'none') {
          goTo((await answerLogin(request)).location, setLeaving);
          return;
        }
        setInfo(data);
      })
      .catch((err) => {
        if (cancelled) return;
        // The site's own mistake (a scope, the response type): it hears about it.
        const back = err?.response?.data?.redirect;
        if (back) return goTo(back, setLeaving);
        setError(t('developers.login.badLink', { error: errorMessage(err) }));
      });
    return () => { cancelled = true; };
  }, [request, prompt]);

  const appName = info ? displayName(info.bot.id, info.name) : '';
  const host = info ? new URL(info.redirect_uri).host : '';

  return (
    <DeveloperPage title={t('developers.login.title')} titleLink={`/oauth2/authorize?${params.toString()}`}>
      <div className="dev-authorize">
        <div className="dev-authorize-card">
          {leaving && <p className="vc-hint" role="status">{t('developers.login.redirecting', { host: leaving })}</p>}
          {!leaving && !info && !error && <p className="vc-hint">{t('developers.authorize.loading')}</p>}
          {!leaving && !info && error && (
            <>
              <p className="error-msg" role="alert">{error}</p>
              <button type="button" className="btn btn-secondary" onClick={() => navigate('/dm')}>{t('developers.back')}</button>
            </>
          )}
          {!leaving && info && (
            <>
              <div className="dev-authorize-bot">
                <Avatar userId={info.bot.id} className="dev-authorize-avatar" />
                <div>
                  <h3>{t('developers.login.wantsAccess', { app: appName })}</h3>
                  <p className="vc-hint">{t('developers.authorize.madeBy', { name: nameOf(info.owner) })}</p>
                </div>
              </div>
              {info.description && <p className="dev-authorize-description">{info.description}</p>}
              {me && (
                <p className="dev-login-me">
                  <Avatar userId={me.id} className="dev-login-me-avatar" />
                  <span>{t('developers.login.loggedInAs', { name: displayName(me.id, me.username) })}</span>
                </p>
              )}
              <h5 className="dev-subheading">{t('developers.login.scopesHeading')}</h5>
              <ul className="dev-login-scopes">
                {info.scopes.map((scope) => <li key={scope}>{t(`developers.login.scopes.${scope}`)}</li>)}
              </ul>
              <p className="vc-hint">{t('developers.login.cannot')}</p>
              <p className="vc-hint dev-authorize-notice">
                {t('developers.login.redirect', { host })} {t('developers.login.privacy', { app: appName })}
              </p>
              {error && <p className="error-msg" role="alert">{error}</p>}
              <div className="dev-form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => answer(true)}>{t('developers.login.cancel')}</button>
                <button type="button" className="btn btn-primary vc-button" onClick={() => answer(false)}>{t('developers.login.submit')}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </DeveloperPage>
  );
}

// A bot's invite link (/oauth2/authorize?client_id=…&scope=bot&permissions=…): the bot, who
// made it, a guild you manage to add it to, and the permissions it asks for, which you can
// untick (and can't give if you don't have them there).
function BotInvite() {
  useProfiles();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const clientId = params.get('client_id');
  const requested = useMemo(() => fromBitfield(params.get('permissions')), [params]);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(clientId ? null : t('developers.authorize.missingClient'));
  const [guildId, setGuildId] = useState(params.get('guild_id') ?? '');
  const [selected, setSelected] = useState(requested);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(null); // the guild it was added to

  useEffect(() => {
    if (!clientId) return;
    fetchAuthorization(clientId)
      .then((data) => {
        rememberBots([data], [data.owner]);
        setInfo(data);
        // A guild_id in the link is only kept if it's one of yours.
        setGuildId((current) => (data.guilds.some((g) => String(g.id) === String(current)) ? String(current) : data.guilds.length === 1 ? String(data.guilds[0].id) : ''));
      })
      .catch((err) => setError(err?.response?.status === 404 ? t('developers.authorize.unknown') : errorMessage(err)));
  }, [clientId]);

  const guild = info?.guilds.find((g) => String(g.id) === String(guildId));
  const grantable = (p) => !guild || canGrant(guild.my_permissions, p);
  const granted = new Set([...selected].filter((name) => grantable(BOT_PERMISSIONS.find((p) => p.name === name))));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authorize({ clientId, guildId: Number(guildId), permissions: toBitfield(granted) });
      setAdded(guild);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const botName = info ? displayName(info.bot.id, info.name) : '';

  return (
    <DeveloperPage title={t('developers.authorize.title')} titleLink={`/oauth2/authorize?${params.toString()}`}>
      <div className="dev-authorize">
        <div className="dev-authorize-card">
          {!info && !error && <p className="vc-hint">{t('developers.authorize.loading')}</p>}
          {!info && error && (
            <>
              <p className="error-msg" role="alert">{error}</p>
              <button type="button" className="btn btn-secondary" onClick={() => navigate('/dm')}>{t('developers.back')}</button>
            </>
          )}
          {info && (
            <>
              <div className="dev-authorize-bot">
                <Avatar userId={info.bot.id} className="dev-authorize-avatar" />
                <div>
                  <h3>
                    {botName} <span className="dev-bot-tag">{t('developers.authorize.bot')}</span>
                  </h3>
                  <p className="vc-hint">{t('developers.authorize.madeBy', { name: nameOf(info.owner) })}</p>
                </div>
              </div>
              {info.description && <p className="dev-authorize-description">{info.description}</p>}

              {added ? (
                <div className="dev-authorize-done" role="status">
                  <p>{t('developers.authorize.done', { bot: botName, guild: added.name })}</p>
                  <button type="button" className="btn btn-primary vc-button" onClick={() => navigate(`/guild/${added.id}`)}>
                    {t('developers.authorize.openGuild', { guild: added.name })}
                  </button>
                </div>
              ) : (
                <form onSubmit={submit}>
                  <label htmlFor="dev-authorize-guild">{t('developers.authorize.guildLabel')}</label>
                  {info.guilds.length ? (
                    <select id="dev-authorize-guild" className="form-select form-control" value={guildId} onChange={(e) => setGuildId(e.target.value)}>
                      <option value="" disabled>{t('developers.authorize.chooseGuild')}</option>
                      {info.guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  ) : (
                    <p className="vc-hint">{t('developers.authorize.noGuilds')}</p>
                  )}

                  <h5 className="dev-subheading">{t('developers.authorize.permissionsHeading')}</h5>
                  {requested.size ? (
                    <PermissionChecklist
                      selected={selected}
                      onChange={setSelected}
                      only={requested}
                      disabled={(p) => !grantable(p)}
                      disabledHint={t('developers.authorize.cantGrant')}
                    />
                  ) : (
                    <p className="vc-hint">{t('developers.authorize.noPermissions')}</p>
                  )}
                  <p className="vc-hint dev-authorize-notice">{t('developers.authorize.notice')}</p>
                  {error && <p className="error-msg" role="alert">{error}</p>}
                  <div className="dev-form-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => navigate('/dm')}>{t('developers.authorize.cancel')}</button>
                    <button type="submit" className="btn btn-primary vc-button" disabled={busy || !guild}>{t('developers.authorize.submit')}</button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </DeveloperPage>
  );
}
