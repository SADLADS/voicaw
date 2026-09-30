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
import { changeMembership } from '../../services/groupKeys';
import { renameGroup } from '../../services/groupService';
import { MAX_GROUP_MEMBERS } from '../../services/groupCrypto';
import { nameOf, useProfiles } from '../../utils/profiles';
import { usePresence } from '../../hooks/usePresence';
import { lastSeenText, statusLabel } from '../../utils/presence';

const errorText = (err) => err.response?.data?.error ?? err.message;

// A group DM's members (from its checked membership log), with the owner's crown. Anyone adds
// people and renames; the owner removes people; anyone leaves.
export default function GroupMembers({ group, user, users, onClose }) {
  useProfiles();
  const presenceOf = usePresence();
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
    <aside className="member-list group-members" aria-label="Members">
      <div className="group-members-header">
        <span>Members — {memberIds.length}</span>
        {onClose && (
          <button type="button" className="guild-sidebar-icon-button" aria-label="Close" onClick={onClose}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        )}
      </div>
      <ul className="group-members-list">
        {memberIds.map((id) => {
          const { status, lastOnline } = presenceOf(usersById.get(id) ?? { id });
          return (
            <li key={id} className="group-member">
              <span className="group-member-avatar-wrap">
                <UserAvatar userId={id} className="group-member-avatar" />
                <StatusIcon status={status} title={status === 'offline' ? lastSeenText(lastOnline) ?? statusLabel(status) : undefined} />
              </span>
              <span className="group-member-name">{names.get(id) ?? 'Someone'}{id === user.id ? ' (you)' : ''}</span>
              {id === log.ownerId && <FontAwesomeIcon icon={faCrown} className="group-owner-crown" title="Group owner" aria-label="Group owner" />}
              {isOwner && id !== user.id && (
                <button
                  type="button"
                  className="guild-sidebar-icon-button"
                  aria-label={`Remove ${names.get(id)}`}
                  title="Remove from group"
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
          <FontAwesomeIcon icon={faUserPlus} /> Add people
        </button>
        <button type="button" className="group-action" onClick={() => { setName(detail.name ?? ''); setDialog({ type: 'rename' }); }}>
          <FontAwesomeIcon icon={faPen} /> Rename
        </button>
        <button type="button" className="group-action danger" onClick={() => setDialog({ type: 'leave' })}>
          <FontAwesomeIcon icon={faRightFromBracket} /> Leave group
        </button>
      </div>

      {dialog?.type === 'add' && (
        <Modal
          title="Add People"
          className="group-dialog"
          onClose={close}
          actions={(
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={close}>Cancel</button>
              <button type="button" className="btn btn-primary btn-sm vc-button" onClick={addPeople} disabled={busy || selected.size === 0}>
                {busy ? 'Adding…' : 'Add'}
              </button>
            </>
          )}
        >
          <p className="vc-hint">They&apos;ll see messages from now on, not what was said before.</p>
          <UserPicker users={users.filter((u) => !log.members.has(u.id))} selected={selected} onChange={setSelected} max={room} />
          {error && <p className="error-msg" role="alert">{error}</p>}
        </Modal>
      )}
      {dialog?.type === 'rename' && (
        <Modal
          title="Rename Group"
          className="group-dialog"
          onClose={close}
          actions={(
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={close}>Cancel</button>
              <button type="button" className="btn btn-primary btn-sm vc-button" onClick={() => run(() => renameGroup(detail.id, name))} disabled={busy}>Save</button>
            </>
          )}
        >
          <input
            className="form-control"
            placeholder="Group name (empty: the members' names)"
            aria-label="Group name"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="vc-hint">Group names aren&apos;t encrypted (messages are).</p>
          {error && <p className="error-msg" role="alert">{error}</p>}
        </Modal>
      )}
      {dialog?.type === 'remove' && (
        <ConfirmDialog
          title={`Remove ${names.get(dialog.id)}`}
          message={`${names.get(dialog.id)} won't see anything sent in this group from now on.`}
          confirmLabel="Remove"
          onConfirm={() => changeMembership(user, detail.id, 'remove', detail.users.find((u) => u.id === dialog.id))}
          onClose={close}
        />
      )}
      {dialog?.type === 'leave' && (
        <ConfirmDialog
          title="Leave group"
          message={isOwner
            ? "You won't see this group any more, and it won't have an owner (nobody can remove people)."
            : "You won't see this group any more unless someone adds you back."}
          confirmLabel="Leave Group"
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
