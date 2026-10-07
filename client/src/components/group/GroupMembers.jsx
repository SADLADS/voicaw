import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCrown, faPen, faRightFromBracket, faUserMinus, faUserPlus, faXmark } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/guilds.css';
import '../../assets/css/groups.css';
import Modal from '../guild/Modal';
import ConfirmDialog from '../guild/ConfirmDialog';
import UserAvatar from '../voice/UserAvatar';
import UserPicker from './UserPicker';
import StatusIcon from '../StatusIcon';
import { changeMembership, renameGroup } from '../../services/groupKeys';
import { MAX_GROUP_MEMBERS, MAX_GROUP_NAME } from '../../services/groupCrypto';
import { nameOf, useProfiles } from '../../utils/profiles';
import { usePresence } from '../../hooks/usePresence';
import { useFriends } from '../../utils/friends';
import { lastSeenText, statusLabel } from '../../utils/presence';
import { t } from '../../i18n';

const errorText = (err) => err.response?.data?.error ?? err.message;

// A group DM's members (from its checked membership log), with the owner's crown. Anyone adds
// people (from their friends, as in Discord) and renames; the owner removes people; anyone leaves.
export default function GroupMembers({ group, user, users, onClose }) {
  useProfiles();
  const presenceOf = usePresence();
  const friends = useFriends();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState(null); // { type: 'add' | 'remove' | 'leave' | 'rename', ... }
  const [selected, setSelected] = useState(new Set());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { detail, log } = group;
  const names = new Map(detail.users.map((u) => [u.id, nameOf(u)]));
  const usersById = new Map(detail.users.map((u) => [u.id, u]));
  const memberIds = [...log.members.keys()];
  const isOwner = log.ownerId === user.id;
  const room = MAX_GROUP_MEMBERS - memberIds.length;

  const close = () => {
    setDialog(null);
    setError(null);
    setBusy(false);
  };

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
      close();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const addPeople = () => run(async () => {
    for (const person of users.filter((u) => selected.has(u.id))) {
      await changeMembership(user, detail.id, 'add', person);
    }
    setSelected(new Set());
  });

  return (
    <aside className="member-list group-members" aria-label={t('common.members')}>
      <div className="group-members-header">
        <span>{t('groups.members.header', { count: memberIds.length })}</span>
        {onClose && (
          <button type="button" className="guild-sidebar-icon-button" aria-label={t('common.close')} onClick={onClose}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        )}
      </div>
      <ul className="group-members-list">
        {memberIds.map((id) => {
          const { status, lastOnline } = presenceOf(usersById.get(id) ?? { id });
          return (
            <li key={id} className="group-member">
              <span className="group-member-avatar-wrap status-avatar">
                <UserAvatar userId={id} className="group-member-avatar" />
                <StatusIcon status={status} title={status === 'offline' ? lastSeenText(lastOnline) ?? statusLabel(status) : undefined} />
              </span>
              <span className="group-member-name">{id === user.id ? t('groups.members.you', { name: names.get(id) ?? t('groups.members.someone') }) : (names.get(id) ?? t('groups.members.someone'))}</span>
              {id === log.ownerId && <FontAwesomeIcon icon={faCrown} className="group-owner-crown" title={t('groups.members.owner')} aria-label={t('groups.members.owner')} />}
              {isOwner && id !== user.id && (
                <button
                  type="button"
                  className="guild-sidebar-icon-button"
                  aria-label={t('groups.members.removeName', { name: names.get(id) })}
                  title={t('groups.members.removeFromGroup')}
                  onClick={() => setDialog({ type: 'remove', id })}
                >
                  <FontAwesomeIcon icon={faUserMinus} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="group-members-actions">
        <button type="button" className="group-action" onClick={() => setDialog({ type: 'add' })} disabled={room <= 0}>
          <FontAwesomeIcon icon={faUserPlus} /> {t('groups.members.addPeople')}
        </button>
        <button type="button" className="group-action" onClick={() => { setName(group.name?.name ?? ''); setDialog({ type: 'rename' }); }}>
          <FontAwesomeIcon icon={faPen} /> {t('groups.members.rename')}
        </button>
        <button type="button" className="group-action danger" onClick={() => setDialog({ type: 'leave' })}>
          <FontAwesomeIcon icon={faRightFromBracket} /> {t('groups.members.leave')}
        </button>
      </div>

      {dialog?.type === 'add' && (
        <Modal
          title={t('groups.members.addTitle')}
          className="group-dialog"
          onClose={close}
          actions={(
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={close}>{t('common.cancel')}</button>
              <button type="button" className="btn btn-primary btn-sm vc-button" onClick={addPeople} disabled={busy || selected.size === 0}>
                {busy ? t('groups.members.adding') : t('common.add')}
              </button>
            </>
          )}
        >
          <p className="vc-hint">{t('groups.members.addHint')}</p>
          <UserPicker users={users.filter((u) => !log.members.has(u.id) && friends.friends.has(Number(u.id)))} selected={selected} onChange={setSelected} max={room} />
          {error && <p className="error-msg" role="alert">{error}</p>}
        </Modal>
      )}
      {dialog?.type === 'rename' && (
        <Modal
          title={t('groups.members.renameTitle')}
          className="group-dialog"
          onClose={close}
          actions={(
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={close}>{t('common.cancel')}</button>
              <button type="button" className="btn btn-primary btn-sm vc-button" onClick={() => run(() => renameGroup(user, detail.id, name))} disabled={busy}>{t('common.save')}</button>
            </>
          )}
        >
          <input
            className="form-control"
            placeholder={t('groups.members.namePlaceholder')}
            aria-label={t('groups.members.nameLabel')}
            maxLength={MAX_GROUP_NAME}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="vc-hint">{t('groups.members.nameHint')}</p>
          {error && <p className="error-msg" role="alert">{error}</p>}
        </Modal>
      )}
      {dialog?.type === 'remove' && (
        <ConfirmDialog
          title={t('groups.members.removeName', { name: names.get(dialog.id) })}
          message={t('groups.members.removeMessage', { name: names.get(dialog.id) })}
          confirmLabel={t('common.remove')}
          onConfirm={() => changeMembership(user, detail.id, 'remove', detail.users.find((u) => u.id === dialog.id))}
          onClose={close}
        />
      )}
      {dialog?.type === 'leave' && (
        <ConfirmDialog
          title={t('groups.members.leave')}
          message={isOwner
            ? t('groups.members.leaveOwnerMessage')
            : t('groups.members.leaveMessage')}
          confirmLabel={t('groups.members.leaveConfirm')}
          onConfirm={async () => {
            await changeMembership(user, detail.id, 'leave');
            navigate('/dm', { replace: true });
          }}
          onClose={close}
        />
      )}
    </aside>
  );
}
