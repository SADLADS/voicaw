import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faIdCard, faPen, faRightFromBracket, faXmark } from '@fortawesome/free-solid-svg-icons';
import Avatar from './Avatar';
import StatusIcon from './StatusIcon';
import StatusEmojiButton from './StatusEmojiButton';
import { usePresence } from '../hooks/usePresence';
import { updateProfile } from '../services/profileService';
import { apiId } from '../utils/copyId';
import { openUserProfile } from '../utils/userProfile';
import { PROFILE_LIMITS, getProfile, mergeProfiles, nameOf, useProfiles } from '../utils/profiles';
import { t } from '../i18n';

const MARGIN = 8;

// The menu the user panel's left side opens (above it): your picture, name and custom status
// (its emoji button, always shown, opens the picker; click the text to change it: Enter or
// clicking away saves it with the emoji, Escape cancels, ✕ clears both), Edit Profile, Copy User ID and
// Log out. Your picture, your names and Edit Profile open your full profile (UserProfile), where
// it's all edited. Right-clicking it opens nothing (neither PageMenus' menu nor the browser's).
// `anchor` is the clicked element's rect; `trigger` its element (clicking it again closes the
// menu through the panel, not as an outside click).
export default function UserMenu({ user, anchor, trigger, onLogout, onClose }) {
  useProfiles();
  const presenceOf = usePresence();
  const ref = useRef(null);
  const [position, setPosition] = useState({ left: anchor.left, bottom: window.innerHeight - anchor.top + MARGIN, visibility: 'hidden' });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftEmoji, setDraftEmoji] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const finished = useRef(false); // Enter or Escape already ended this edit (so blur doesn't)
  const editRef = useRef(null); // the text box and its emoji button
  const inputRef = useRef(null);
  const profile = { ...user, ...getProfile(user.id) };
  const customStatus = profile.custom_status ?? '';
  const customEmoji = profile.custom_status_emoji ?? null;
  const hasStatus = Boolean(customStatus || customEmoji);

  // Above what was clicked, within the window.
  useLayoutEffect(() => {
    const box = ref.current.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - box.width - MARGIN));
    const bottom = Math.max(MARGIN, window.innerHeight - anchor.top + MARGIN);
    setPosition({ left, bottom });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e) => {
      if (!ref.current?.contains(e.target) && !trigger?.contains(e.target)) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape' && !editing) onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, trigger, editing]);

  async function saveStatus(value, emoji) {
    const next = value.trim();
    if (next === customStatus && emoji === customEmoji) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      mergeProfiles([await updateProfile({ customStatus: next || null, customStatusEmoji: emoji })]);
      setEditing(false);
    } catch (err) {
      setError(err.response?.data?.error ?? t('app.userMenu.statusSaveFailed'));
      finished.current = false;
    } finally {
      setSaving(false);
    }
  }

  const openProfile = () => {
    onClose();
    openUserProfile(user.id);
  };

  return createPortal(
    <div className="user-menu" ref={ref} style={position} role="dialog" onContextMenu={(e) => e.preventDefault()} aria-label={t('app.userMenu.yourAccount')}>
      <div className="user-menu-top">
        <button type="button" className="user-menu-avatar status-avatar user-menu-open" aria-label={t('app.profile.open')} onClick={openProfile}>
          <Avatar userId={user.id} />
          <StatusIcon status={presenceOf(profile).status} />
        </button>
        <div className="user-menu-names">
          <button type="button" className="user-menu-name user-menu-open" onClick={openProfile}>{nameOf(profile)}</button>
          {profile.display_name && <button type="button" className="user-menu-username user-menu-open" onClick={openProfile}>{profile.username}</button>}
          <div className="user-menu-status-row" ref={editRef}>
            {/* Always there: picking saves at once, or goes with the text while it's edited. */}
            <StatusEmojiButton
              emoji={editing ? draftEmoji : customEmoji}
              removable={editing}
              disabled={saving}
              onChange={(emoji) => {
                if (!editing) return saveStatus(customStatus, emoji);
                setDraftEmoji(emoji);
                inputRef.current?.focus();
              }}
              onPickerClosed={() => inputRef.current?.focus()}
            />
            {editing ? (
              <input
                ref={inputRef}
                className="user-menu-status-input"
                aria-label={t('app.userMenu.customStatus')}
                placeholder={t('app.userMenu.statusPlaceholder')}
                value={draft}
                maxLength={PROFILE_LIMITS.custom_status}
                disabled={saving}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                // Moving to the emoji button or its picker isn't leaving the edit.
                onBlur={(e) => { if (!finished.current && !editRef.current?.contains(e.relatedTarget)) saveStatus(draft, draftEmoji); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    finished.current = true;
                    saveStatus(draft, draftEmoji);
                  }
                  if (e.key === 'Escape') {
                    finished.current = true;
                    e.stopPropagation();
                    setEditing(false);
                    setError(null);
                  }
                }}
              />
            ) : (
              <>
                <button
                  type="button"
                  className={`user-menu-status${customStatus ? '' : ' empty'}`}
                  title={t('app.userMenu.changeStatus')}
                  onClick={() => { setDraft(customStatus); setDraftEmoji(customEmoji); finished.current = false; setEditing(true); }}
                >
                  <span>{customStatus || t('app.userMenu.setStatus')}</span>
                </button>
                {hasStatus && (
                  <button type="button" className="user-menu-status-clear" aria-label={t('app.userMenu.clearStatus')} title={t('app.userMenu.clear')} disabled={saving} onClick={() => saveStatus('', null)}>
                    <FontAwesomeIcon icon={faXmark} />
                  </button>
                )}
              </>
            )}
          </div>
          {error && <div className="user-menu-error">{error}</div>}
        </div>
      </div>
      <div className="user-menu-actions">
        <button type="button" className="user-menu-item" onClick={openProfile}>
          <FontAwesomeIcon icon={faPen} /> {t('app.userMenu.editProfile')}
        </button>
        <button
          type="button"
          className="user-menu-item"
          onClick={() => {
            onClose();
            navigator.clipboard.writeText(apiId('user', user.id));
          }}
        >
          <FontAwesomeIcon icon={faIdCard} /> {t('common.copyId.user')}
        </button>
        <button type="button" className="user-menu-item danger" onClick={() => { onClose(); onLogout?.(); }}>
          <FontAwesomeIcon icon={faRightFromBracket} /> {t('app.userMenu.logOut')}
        </button>
      </div>
    </div>,
    document.body
  );
}
