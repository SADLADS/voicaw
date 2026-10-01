import React, { useEffect, useRef, useState } from 'react';
import defaultpfp from '../assets/images/default.png';
import { useAuth } from '../hooks/useAuth';
import Avatar from './Avatar';
import ProfileCard from './ProfileCard';
import { MAX_PROFILE_PIC_BYTES, removeProfilePicture, updateProfile, uploadProfilePicture } from '../services/profileService';
import { PROFILE_LIMITS, getProfile, mergeProfiles, useProfiles } from '../utils/profiles';

const FIELDS = ['display_name', 'custom_status', 'bio'];
const fromProfile = (profile) => Object.fromEntries(FIELDS.map((f) => [f, profile?.[f] ?? '']));

// Settings → Edit Profile (/settings/profile): picture, display name, custom status and bio,
// with a preview of your profile card as others will see it. Nothing is saved until Save
// (which uploads a new picture, if one was picked, or removes yours, and saves the rest);
// Reset drops changes.
export default function EditProfile() {
  const { user } = useAuth();
  useProfiles();
  const saved = getProfile(user.id);
  const [draft, setDraft] = useState(() => fromProfile(saved));
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null); // the picked picture's blob URL
  const [removing, setRemoving] = useState(false); // back to the default picture on save
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const fileInput = useRef(null);
  // The saved profile may arrive after the page opens; start from it then, unless typing began.
  const touched = useRef(false);

  useEffect(() => {
    if (!touched.current && saved) setDraft(fromProfile(saved));
  }, [saved]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const changedFields = FIELDS.filter((f) => (draft[f].trim() || null) !== (saved?.[f] ?? null));
  const dirty = changedFields.length > 0 || file != null || removing;

  function change(field, value) {
    touched.current = true;
    setDone(false);
    setDraft((d) => ({ ...d, [field]: value }));
  }

  function pick(e) {
    const f = e.target.files[0];
    e.target.value = '';
    setDone(false);
    if (!f) return;
    if (!f.type.startsWith('image/')) {
      setError('Only image files are allowed.');
      return;
    }
    if (f.size > MAX_PROFILE_PIC_BYTES) {
      setError('That image is too large (max 8 MB).');
      return;
    }
    setError(null);
    setRemoving(false);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }

  function removePicture() {
    setDone(false);
    setFile(null);
    setPreview(null);
    setRemoving(true);
  }

  function reset() {
    touched.current = false;
    setDraft(fromProfile(saved));
    setFile(null);
    setPreview(null);
    setRemoving(false);
    setError(null);
    setDone(false);
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      if (file) {
        mergeProfiles([await uploadProfilePicture(file)]);
        setFile(null);
        setPreview(null);
      } else if (removing) {
        mergeProfiles([await removeProfilePicture()]);
        setRemoving(false);
      }
      if (changedFields.length) {
        const keys = { display_name: 'displayName', custom_status: 'customStatus', bio: 'bio' };
        const profile = await updateProfile(Object.fromEntries(changedFields.map((f) => [keys[f], draft[f].trim()])));
        mergeProfiles([profile]);
        touched.current = false;
        setDraft(fromProfile(profile));
      }
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Saving failed');
    } finally {
      setBusy(false);
    }
  }

  // What the picture will be: the picked one, the default (removing), or the saved one.
  const pictureSrc = preview ?? (removing ? defaultpfp : undefined);
  const counter = (field) => `${draft[field].length}/${PROFILE_LIMITS[field]}`;

  return (
    <div className="edit-profile">
      <h3 className="settings-category-title">Edit Profile</h3>
      <div className="edit-profile-body">
        <form className="edit-profile-form" onSubmit={save} aria-label="Edit profile">
          <div className="edit-profile-field">
            <span className="edit-profile-label">Profile picture</span>
            <div className="edit-profile-picture">
              <Avatar userId={user.id} src={pictureSrc} alt="Your profile picture" />
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => fileInput.current?.click()}>
                Change picture
              </button>
              {(preview || (getProfile(user.id)?.avatar && !removing)) && (
                <button type="button" className="btn btn-sm btn-outline-danger" onClick={removePicture}>Remove</button>
              )}
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={pick} aria-label="Choose a profile picture" />
            </div>
            <span className="vc-hint">PNG, JPEG, GIF or WebP, up to 8 MB; cropped to a square. Everyone can see it.</span>
          </div>

          <label className="edit-profile-field">
            <span className="edit-profile-label">Display name <span className="edit-profile-count">{counter('display_name')}</span></span>
            <input
              className="form-control"
              value={draft.display_name}
              maxLength={PROFILE_LIMITS.display_name}
              placeholder={user.username}
              onChange={(e) => change('display_name', e.target.value)}
            />
            <span className="vc-hint">Shown instead of your username ({user.username}). Leave it empty to use your username.</span>
          </label>

          <label className="edit-profile-field">
            <span className="edit-profile-label">Custom status <span className="edit-profile-count">{counter('custom_status')}</span></span>
            <input
              className="form-control"
              value={draft.custom_status}
              maxLength={PROFILE_LIMITS.custom_status}
              placeholder="What are you up to?"
              onChange={(e) => change('custom_status', e.target.value)}
            />
          </label>

          <label className="edit-profile-field">
            <span className="edit-profile-label">About me <span className="edit-profile-count">{counter('bio')}</span></span>
            <textarea
              className="form-control"
              rows={4}
              value={draft.bio}
              maxLength={PROFILE_LIMITS.bio}
              placeholder="A few words about you"
              onChange={(e) => change('bio', e.target.value)}
            />
          </label>

          {error && <p className="error-msg" role="alert">{error}</p>}
          {done && !dirty && <p className="success-msg" role="status">Profile saved.</p>}
          <div className="edit-profile-actions">
            <button type="submit" className="btn btn-sm uploadbutton" disabled={!dirty || busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            <button type="button" className="btn btn-sm btn-secondary" onClick={reset} disabled={!dirty || busy}>Reset</button>
          </div>
        </form>

        <div className="edit-profile-preview">
          <span className="edit-profile-label">Preview</span>
          <div className="member-card">
            <ProfileCard
              user={{ id: user.id, username: user.username }}
              draft={Object.fromEntries(FIELDS.map((f) => [f, draft[f].trim() || null]))}
              avatarSrc={pictureSrc}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
