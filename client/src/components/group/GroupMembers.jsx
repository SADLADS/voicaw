import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCrown, faImage, faPen, faRightFromBracket, faUserMinus, faUserPlus, faXmark } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/guilds.css';
import '../../assets/css/groups.css';
import Modal from '../guild/Modal';
import ConfirmDialog from '../guild/ConfirmDialog';
import UserAvatar from '../voice/UserAvatar';
import UserPicker from './UserPicker';
import ImageCropper from '../ImageCropper';
import StatusIcon from '../StatusIcon';
import ProfileCard from '../ProfileCard';
import { changeMembership, renameGroup, setGroupPicture } from '../../services/groupKeys';
import { MAX_GROUP_MEMBERS, MAX_GROUP_NAME } from '../../services/groupCrypto';
import { nameOf, useProfiles } from '../../utils/profiles';
import { croppedPictureBytes, croppedPreview } from '../../utils/pictureData';
import { MAX_PROFILE_PIC_BYTES } from '../../services/profileService';
import { useGroupPicture } from '../../hooks/useGroupPicture';
import { usePresence } from '../../hooks/usePresence';
import { useFloatingCard } from '../../hooks/useFloatingCard';
import { useFriends } from '../../utils/friends';
import { lastSeenText, statusLabel } from '../../utils/presence';
import { t } from '../../i18n';

const errorText = (err) => err.response?.data?.error ?? err.message;

// A group DM's members (from its checked membership log), with the owner's crown. Anyone adds
// people (from their friends, as in Discord), renames and changes the picture (cropped here, then
// encrypted: see Group pictures in docs/group-dms.md); the owner removes people; anyone leaves.
// Clicking someone opens their profile card over the chat, as in the guild member list
// (hooks/useFloatingCard.js); right-clicking them, their menu (utils/personMenu.js).
export default function GroupMembers({ group, user, users, onClose }) {
  useProfiles();
  const presenceOf = usePresence();
  const friends = useFriends();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState(null); // { type: 'add' | 'remove' | 'leave' | 'rename' | 'picture', ... }
  const [selected, setSelected] = useState(new Set());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The picture dialog: a picked file in the cropper, then the cropped one ({ file, crop,
  // preview (blob URL) }) or null to remove the picture, until saved.
  const [cropping, setCropping] = useState(null);
  const [newPicture, setNewPicture] = useState(undefined); // undefined: unchanged
  const fileInput = useRef(null);
  const [cardFor, setCardFor] = useState(null);
  const listRef = useRef(null);
  const cardRef = useRef(null);
  const closeCard = useCallback(() => setCardFor(null), []);
  const cardStyle = useFloatingCard(cardFor, { listRef, cardRef, rowSelector: '.group-member-open', onClose: closeCard });
  const { detail, log } = group;
  const pictureUrl = useGroupPicture(detail.id, group.name?.picture);

  useEffect(() => () => { if (newPicture?.preview) URL.revokeObjectURL(newPicture.preview); }, [newPicture]);
  const names = new Map(detail.users.map((u) => [u.id, nameOf(u)]));
  const usersById = new Map(detail.users.map((u) => [u.id, u]));
  const memberIds = [...log.members.keys()];
  const isOwner = log.ownerId === user.id;
  const room = MAX_GROUP_MEMBERS - memberIds.length;

  const close = () => {
    setDialog(null);
    setError(null);
    setBusy(false);
    setNewPicture(undefined);
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

  function pickPicture(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return setError(t('settings.profile.onlyImages'));
    if (file.size > MAX_PROFILE_PIC_BYTES) return setError(t('settings.profile.tooLarge'));
    setError(null);
    setCropping(file);
  }

  async function applyCrop(crop) {
    const file = cropping;
    setCropping(null);
    try {
      setNewPicture({ file, crop, preview: await croppedPreview(file, crop) });
    } catch {
      setError(t('media.cropper.loadFailed'));
    }
  }

  const savePicture = () => run(async () => {
    const bytes = newPicture ? await croppedPictureBytes(newPicture.file, newPicture.crop) : null;
    await setGroupPicture(user, detail.id, bytes);
  });

  const shownPicture = newPicture === undefined ? pictureUrl : newPicture?.preview;

  return (
    <aside ref={listRef} className="member-list group-members" aria-label={t('common.members')}>
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
            <li key={id} className={`group-member${cardFor === id ? ' selected' : ''}`}>
              <button type="button" className="group-member-open" data-user-id={id} onClick={() => setCardFor(cardFor === id ? null : id)}>
                <span className="group-member-avatar-wrap status-avatar">
                  <UserAvatar userId={id} className="group-member-avatar" />
                  <StatusIcon status={status} title={status === 'offline' ? lastSeenText(lastOnline) ?? statusLabel(status) : undefined} />
                </span>
                <span className="group-member-name">{id === user.id ? t('groups.members.you', { name: names.get(id) ?? t('groups.members.someone') }) : (names.get(id) ?? t('groups.members.someone'))}</span>
                {id === log.ownerId && <FontAwesomeIcon icon={faCrown} className="group-owner-crown" title={t('groups.members.owner')} aria-label={t('groups.members.owner')} />}
              </button>
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
      {cardFor != null && usersById.has(cardFor) && createPortal(
        <div className="profile-popover member-card" ref={cardRef} style={cardStyle} role="dialog" aria-label={names.get(cardFor)}>
          <ProfileCard user={usersById.get(cardFor)} />
        </div>,
        document.body
      )}
      <div className="group-members-actions">
        <button type="button" className="group-action" onClick={() => setDialog({ type: 'add' })} disabled={room <= 0}>
          <FontAwesomeIcon icon={faUserPlus} /> {t('groups.members.addPeople')}
        </button>
        <button type="button" className="group-action" onClick={() => { setName(group.name?.name ?? ''); setDialog({ type: 'rename' }); }}>
          <FontAwesomeIcon icon={faPen} /> {t('groups.members.rename')}
        </button>
        <button type="button" className="group-action" onClick={() => setDialog({ type: 'picture' })}>
          <FontAwesomeIcon icon={faImage} /> {t('groups.members.changePicture')}
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
      {dialog?.type === 'picture' && (
        <Modal
          title={t('groups.members.pictureTitle')}
          className="group-dialog"
          onClose={close}
          actions={(
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={close}>{t('common.cancel')}</button>
              <button type="button" className="btn btn-primary btn-sm vc-button" onClick={savePicture} disabled={busy || newPicture === undefined}>
                {busy ? t('groups.members.pictureSaving') : t('common.save')}
              </button>
            </>
          )}
        >
          <div className="group-picture-edit">
            {shownPicture
              ? <img src={shownPicture} alt="" className="group-picture-preview" />
              : <span className="group-picture-preview group-picture-empty"><FontAwesomeIcon icon={faImage} /></span>}
            <div className="group-picture-buttons">
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => fileInput.current?.click()} disabled={busy}>
                {t('groups.members.uploadPicture')}
              </button>
              {shownPicture && (
                <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => setNewPicture(null)} disabled={busy}>
                  {t('common.remove')}
                </button>
              )}
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={pickPicture} aria-label={t('groups.members.choosePicture')} />
            </div>
          </div>
          <p className="vc-hint">{t('groups.members.pictureHint')}</p>
          {error && <p className="error-msg" role="alert">{error}</p>}
        </Modal>
      )}
      {cropping && <ImageCropper file={cropping} onApply={applyCrop} onCancel={() => setCropping(null)} />}
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
