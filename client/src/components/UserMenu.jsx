import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFaceSmile, faPen, faRightFromBracket, faXmark } from '@fortawesome/free-solid-svg-icons';
import Avatar from './Avatar';
import StatusIcon from './StatusIcon';
import { usePresence } from '../hooks/usePresence';
import { updateProfile } from '../services/profileService';
import { PROFILE_LIMITS, getProfile, mergeProfiles, nameOf, useProfiles } from '../utils/profiles';

const MARGIN = 8;

// The menu the user panel's left side opens (above it): your picture, name and custom status
// (click it to change it: Enter saves, Escape cancels, ✕ clears), Edit Profile and Log out.
// `anchor` is the clicked element's rect; `trigger` its element (clicking it again closes the
// menu through the panel, not as an outside click).
export default function UserMenu({ user, anchor, trigger, onLogout, onClose }) {
  useProfiles();
  const presenceOf = usePresence();
  const navigate = useNavigate();
  const ref = useRef(null);
  const [position, setPosition] = useState({ left: anchor.left, bottom: window.innerHeight - anchor.top + MARGIN, visibility: 'hidden' });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const finished = useRef(false); // Enter or Escape already ended this edit (so blur doesn't)
  const profile = { ...user, ...getProfile(user.id) };
  const customStatus = profile.custom_status ?? '';

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

  async function saveStatus(value) {
    const next = value.trim();
    if (next === customStatus) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      mergeProfiles([await updateProfile({ customStatus: next || null })]);
      setEditing(false);
    } catch (err) {
      setError(err.response?.data?.error ?? 'Could not save your status.');
      finished.current = false;
    } finally {
      setSaving(false);
    }
  }

  const go = (path) => {
    onClose();
    navigate(path);
  };

  return createPortal(
    <div className="user-menu" ref={ref} style={position} role="dialog" aria-label="Your account">
      <div className="user-menu-top">
        <span className="user-menu-avatar status-avatar">
          <Avatar userId={user.id} />
          <StatusIcon status={presenceOf(profile).status} />
        </span>
        <div className="user-menu-names">
          <div className="user-menu-name">{nameOf(profile)}</div>
          {profile.display_name && <div className="user-menu-username">{profile.username}</div>}
          {editing ? (
            <input
              className="user-menu-status-input"
              aria-label="Custom status"
              placeholder="What's up?"
              value={draft}
              maxLength={PROFILE_LIMITS.custom_status}
              disabled={saving}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => { if (!finished.current) saveStatus(draft); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  finished.current = true;
                  saveStatus(draft);
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
            <div className="user-menu-status-row">
              <button
                type="button"
                className={`user-menu-status${customStatus ? '' : ' empty'}`}
                title="Change your custom status"
                onClick={() => { setDraft(customStatus); finished.current = false; setEditing(true); }}
              >
                {!customStatus && <FontAwesomeIcon icon={faFaceSmile} />}
                <span>{customStatus || 'Set a custom status'}</span>
              </button>
              {customStatus && (
                <button type="button" className="user-menu-status-clear" aria-label="Clear custom status" title="Clear" disabled={saving} onClick={() => saveStatus('')}>
                  <FontAwesomeIcon icon={faXmark} />
                </button>
              )}
            </div>
          )}
          {error && <div className="user-menu-error">{error}</div>}
        </div>
      </div>
      <div className="user-menu-actions">
        <button type="button" className="user-menu-item" onClick={() => go('/settings/profile')}>
          <FontAwesomeIcon icon={faPen} /> Edit Profile
        </button>
        <button type="button" className="user-menu-item danger" onClick={() => { onClose(); onLogout?.(); }}>
          <FontAwesomeIcon icon={faRightFromBracket} /> Log out
        </button>
      </div>
    </div>,
    document.body
  );
}
