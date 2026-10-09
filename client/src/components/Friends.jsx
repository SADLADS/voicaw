import React, { useContext, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faMessage, faUserGroup, faUserMinus, faUserPlus, faXmark } from '@fortawesome/free-solid-svg-icons';
import { LayoutContext } from '../contexts';
import PaneBackButton from './PaneBackButton';
import Avatar from './Avatar';
import StatusIcon from './StatusIcon';
import CustomStatus from './CustomStatus';
import ActivityLine from './ActivityLine';
import { useActivities } from '../hooks/useActivities';
import ConfirmDialog from './guild/ConfirmDialog';
import { usePresence } from '../hooks/usePresence';
import { lastSeenText, statusLabel } from '../utils/presence';
import { displayName, getProfile, isDeleted, nameOf, useProfiles } from '../utils/profiles';
import { addFriend, addFriendByName, relationOf, removeFriend, useFriends } from '../utils/friends';
import { t } from '../i18n';

const TABS = ['online', 'all', 'pending'];

// The Friends page (/dm/friends, utils/friends.js), as Discord's: your friends who are online,
// all of them, requests waiting either way (Accept / Decline, or Cancel), and a box to send a
// request by username. Admins also get Everyone: every account, as the DM list was before
// friends. Clicking someone opens your DM with them.
export default function Friends() {
  useProfiles();
  const { users = [] } = useContext(LayoutContext) ?? {};
  const friends = useFriends();
  const presenceOf = usePresence();
  const activitiesOf = useActivities();
  const navigate = useNavigate();
  const [tab, setTab] = useState(() => (friends.incoming.length > 0 ? 'pending' : 'online'));
  const [query, setQuery] = useState('');
  const [removing, setRemoving] = useState(null); // the friend whose removal is being confirmed
  const [error, setError] = useState(null);

  const byId = new Map(users.map((u) => [Number(u.id), u]));
  const personOf = (id) => byId.get(Number(id)) ?? { id, ...getProfile(id) };
  const tabs = [...TABS, ...(friends.admin ? ['everyone'] : [])];
  const shownTab = tabs.includes(tab) || tab === 'add' ? tab : 'online';

  // Each row: { person, kind } with kind 'friend', 'incoming', 'outgoing' or, on Everyone, the
  // relation (null for nobody).
  let rows;
  if (shownTab === 'pending') {
    rows = [
      ...friends.incoming.map((r) => ({ person: personOf(r.id), kind: 'incoming' })),
      ...friends.outgoing.map((r) => ({ person: personOf(r.id), kind: 'outgoing' })),
    ];
  } else if (shownTab === 'everyone') {
    rows = users.filter((u) => !isDeleted(u)).map((u) => ({ person: u, kind: relationOf(friends, u.id) }));
  } else {
    rows = [...friends.friends].map((id) => ({ person: personOf(id), kind: 'friend' }));
    if (shownTab === 'online') rows = rows.filter((r) => presenceOf(r.person).status !== 'offline');
  }
  if (shownTab !== 'pending') rows.sort((a, b) => nameOf(a.person).localeCompare(nameOf(b.person)));
  const total = rows.length;
  const q = query.trim().toLowerCase();
  if (q) {
    rows = rows.filter(({ person }) => nameOf(person).toLowerCase().includes(q) || (person.username ?? '').toLowerCase().includes(q));
  }

  const act = (action) => {
    setError(null);
    action().catch(() => setError(t('friends.actionFailed')));
  };
  const open = (id) => navigate(`/dm/${id}`);

  const actionButton = (label, icon, onClick, className = '') => (
    <button
      type="button"
      className={`friends-action ${className}`}
      aria-label={label}
      title={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <FontAwesomeIcon icon={icon} />
    </button>
  );

  const actions = ({ person, kind }) => {
    const id = Number(person.id);
    const name = nameOf(person);
    const message = actionButton(t('friends.message'), faMessage, () => open(id));
    switch (kind) {
      case 'friend':
        return <>{message}{actionButton(t('friends.remove'), faUserMinus, () => setRemoving({ id, name }), 'danger')}</>;
      case 'incoming':
        return (
          <>
            {actionButton(t('friends.accept'), faCheck, () => act(() => addFriend(id)), 'accept')}
            {actionButton(t('friends.decline'), faXmark, () => act(() => removeFriend(id)), 'danger')}
          </>
        );
      case 'outgoing':
        return actionButton(t('friends.cancel'), faXmark, () => act(() => removeFriend(id)), 'danger');
      default:
        return <>{message}{actionButton(t('friends.addFriend'), faUserPlus, () => act(() => addFriend(id)))}</>;
    }
  };

  const subtitle = ({ person, kind }) => {
    if (kind === 'incoming') return t('friends.incoming');
    if (kind === 'outgoing') return t('friends.outgoing');
    const profile = getProfile(person.id) ?? person;
    if (profile.custom_status || profile.custom_status_emoji) return <CustomStatus profile={profile} />;
    if (activitiesOf(person.id).length) return <ActivityLine userId={person.id} />;
    const { status, lastOnline } = presenceOf(person);
    return status === 'offline' ? lastSeenText(lastOnline) ?? statusLabel(status) : statusLabel(status);
  };

  const emptyText = () => (q ? t('friends.empty.search') : shownTab === 'everyone' ? null : t(`friends.empty.${shownTab}`));

  return (
    <div id="dm-main" className="friends-main">
      <h4 className="chat-recipient-header friends-header">
        <PaneBackButton />
        <FontAwesomeIcon icon={faUserGroup} className="notes-header-icon" />
        <span className="friends-title">{t('friends.title')}</span>
        <span className="friends-tabs" role="tablist">
          {tabs.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={shownTab === name}
              className={`friends-tab${shownTab === name ? ' active' : ''}`}
              onClick={() => setTab(name)}
            >
              {t(`friends.tabs.${name}`)}
              {name === 'pending' && friends.incoming.length > 0 && <span className="friends-badge">{friends.incoming.length}</span>}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={shownTab === 'add'}
            className={`friends-tab friends-tab-add${shownTab === 'add' ? ' active' : ''}`}
            onClick={() => setTab('add')}
          >
            {t('friends.tabs.add')}
          </button>
        </span>
      </h4>

      <div className="friends-body">
        {shownTab === 'add' ? (
          <AddFriend />
        ) : (
          <>
            <input
              type="search"
              className="form-control friends-search"
              placeholder={t('friends.search')}
              aria-label={t('friends.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="friends-count">{t(`friends.count.${shownTab}`, { count: total })}</div>
            {shownTab === 'everyone' && <p className="vc-hint">{t('friends.everyoneHint')}</p>}
            {error && <p className="error-text">{error}</p>}
            {rows.length === 0 && emptyText() && <p className="vc-hint friends-empty">{emptyText()}</p>}
            <ul className="friends-list">
              {rows.map((row) => {
                const { person } = row;
                const { status, lastOnline } = presenceOf(person);
                return (
                  <li key={`${row.kind}-${person.id}`}>
                    <div
                      className="friends-row"
                      role="button"
                      tabIndex={0}
                      onClick={() => open(person.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') open(person.id); }}
                    >
                      <span className="dm-user-avatar-wrap status-avatar">
                        <Avatar userId={person.id} alt={nameOf(person)} className="dm-user-avatar" />
                        <StatusIcon status={status} title={status === 'offline' ? lastSeenText(lastOnline) ?? statusLabel(status) : undefined} />
                      </span>
                      <span className="friends-names">
                        <span className="friends-name">
                          {displayName(person.id, nameOf(person))}
                          {(getProfile(person.id) ?? person).display_name && <span className="friends-username">{person.username}</span>}
                        </span>
                        <span className="friends-subtitle">{subtitle(row)}</span>
                      </span>
                      <span className="friends-actions">{actions(row)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {removing && (
        <ConfirmDialog
          title={t('friends.removeConfirmTitle', { name: removing.name })}
          message={t('friends.removeConfirm')}
          confirmLabel={t('friends.remove')}
          onConfirm={() => removeFriend(removing.id)}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

const ADD_ERRORS = { not_found: 'friends.add.notFound', self: 'friends.add.self', blocked: 'friends.add.blocked' };

// The Add friend tab: a request by username.
function AddFriend() {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null); // { ok, text }

  async function submit(e) {
    e.preventDefault();
    const name = username.trim();
    if (!name) return;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await addFriendByName(name);
      setOutcome({ ok: true, text: t(`friends.add.${result}`, { name }) });
      setUsername('');
    } catch (err) {
      setOutcome({ ok: false, text: t(ADD_ERRORS[err.response?.data?.code] ?? 'friends.add.failed') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="friends-add" onSubmit={submit}>
      <h5>{t('friends.add.title')}</h5>
      <p className="vc-hint">{t('friends.add.hint')}</p>
      <div className="friends-add-row">
        <input
          className="form-control"
          placeholder={t('friends.add.placeholder')}
          aria-label={t('friends.add.placeholder')}
          value={username}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={64}
          onChange={(e) => { setUsername(e.target.value); setOutcome(null); }}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !username.trim()}>{t('friends.add.send')}</button>
      </div>
      {outcome && <p className={outcome.ok ? 'friends-add-ok' : 'error-text'} role="status">{outcome.text}</p>}
    </form>
  );
}
