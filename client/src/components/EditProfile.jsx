import React, { useEffect, useRef, useState } from 'react';
import defaultpfp from '../assets/images/default.png';
import { useAuth } from '../hooks/useAuth';
import Avatar from './Avatar';
import ProfileCard from './ProfileCard';
import StatusEmojiButton from './StatusEmojiButton';
import ImageCropper from './ImageCropper';
import ProfileBanner from './ProfileBanner';
import {
  pictureFileError, removeBanner, removeProfilePicture, updateProfile, uploadBanner, uploadProfilePicture,
} from '../services/profileService';
import { colorToHex } from '../utils/permissions';
import { PROFILE_LIMITS, getProfile, mergeProfiles, useProfiles } from '../utils/profiles';
import { croppedPreview } from '../utils/pictureData';
import { t } from '../i18n';

const FIELDS = ['display_name', 'custom_status', 'custom_status_emoji', 'bio'];
const fromProfile = (profile) => Object.fromEntries(FIELDS.map((f) => [f, profile?.[f] ?? '']));

// Settings → Edit Profile (/settings/profile): picture, banner (a picture cut to 5:2, or a
// colour), display name, custom status (and its emoji) and bio, with a preview of your profile
// card as others will see it. A picked picture or banner opens the cropper (ImageCropper) first.
// Nothing is saved until Save (which uploads a new picture or banner, if one was picked, or
// removes yours, and saves the rest); Reset drops changes. (Your full profile, UserProfile, edits
// the same things in place.)
const BANNER_ASPECT = 2.5;
// What the colour picker starts at before a colour is chosen (the app's accent).
const DEFAULT_PICKER_COLOUR = 0x6a52c9;
export default function EditProfile() {
  const { user } = useAuth();
  useProfiles();
  const saved = getProfile(user.id);
  const [draft, setDraft] = useState(() => fromProfile(saved));
  const [file, setFile] = useState(null);
  const [crop, setCrop] = useState(null); // the part of `file` chosen in the cropper
  const [cropping, setCropping] = useState(null); // { file, kind: 'avatar' | 'banner' } in the cropper
  // The banner: a picked picture (as the avatar's), removing it, and its colour (0xRRGGBB or null).
  const [banner, setBanner] = useState(null); // { file, crop, preview }
  const [removingBanner, setRemovingBanner] = useState(false);
  const [bannerColor, setBannerColor] = useState(() => saved?.banner_color ?? null);
  const [preview, setPreview] = useState(null); // the cropped picture's blob URL
  const [removing, setRemoving] = useState(false); // back to the default picture on save
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const fileInput = useRef(null);
  const bannerInput = useRef(null);
  // The saved profile may arrive after the page opens; start from it then, unless typing began.
  const touched = useRef(false);

  useEffect(() => {
    if (!touched.current && saved) {
      setDraft(fromProfile(saved));
      setBannerColor(saved.banner_color ?? null);
    }
  }, [saved]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => () => { if (banner?.preview) URL.revokeObjectURL(banner.preview); }, [banner]);

  const changedFields = FIELDS.filter((f) => (draft[f].trim() || null) !== (saved?.[f] ?? null));
  const colorChanged = bannerColor !== (saved?.banner_color ?? null);
  const dirty = changedFields.length > 0 || file != null || removing || banner != null || removingBanner || colorChanged;

  function change(field, value) {
    touched.current = true;
    setDone(false);
    setDraft((d) => ({ ...d, [field]: value }));
  }

  const pick = (kind) => (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    setDone(false);
    if (!f) return;
    const problem = pictureFileError(f);
    setError(problem);
    if (!problem) setCropping({ file: f, kind });
  };

  async function applyCrop(chosen) {
    const { file: f, kind } = cropping;
    setCropping(null);
    if (kind === 'banner') {
      // The whole picture stands in (the preview's banner is cut by CSS, close enough).
      setRemovingBanner(false);
      setBanner({ file: f, crop: chosen, preview: URL.createObjectURL(f) });
      return;
    }
    let url;
    try {
      url = await croppedPreview(f, chosen);
    } catch {
      url = URL.createObjectURL(f); // can't draw it here: the whole picture stands in
    }
    setRemoving(false);
    setFile(f);
    setCrop(chosen);
    setPreview(url);
  }

  function changeBannerColor(value) {
    touched.current = true;
    setDone(false);
    setBannerColor(value);
  }

  function removePicture() {
    setDone(false);
    setFile(null);
    setCrop(null);
    setPreview(null);
    setRemoving(true);
  }

  function reset() {
    touched.current = false;
    setDraft(fromProfile(saved));
    setFile(null);
    setCrop(null);
    setPreview(null);
    setRemoving(false);
    setBanner(null);
    setRemovingBanner(false);
    setBannerColor(saved?.banner_color ?? null);
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
        mergeProfiles([await uploadProfilePicture(file, crop)]);
        setFile(null);
        setCrop(null);
        setPreview(null);
      } else if (removing) {
        mergeProfiles([await removeProfilePicture()]);
        setRemoving(false);
      }
      if (banner) {
        mergeProfiles([await uploadBanner(banner.file, banner.crop)]);
        setBanner(null);
      } else if (removingBanner) {
        mergeProfiles([await removeBanner()]);
        setRemovingBanner(false);
      }
      if (changedFields.length || colorChanged) {
        const keys = { display_name: 'displayName', custom_status: 'customStatus', custom_status_emoji: 'customStatusEmoji', bio: 'bio' };
        const profile = await updateProfile({
          ...Object.fromEntries(changedFields.map((f) => [keys[f], draft[f].trim()])),
          ...(colorChanged ? { bannerColor } : {}),
        });
        mergeProfiles([profile]);
        touched.current = false;
        setDraft(fromProfile(profile));
      }
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.error || err.message || t('settings.savingFailed'));
    } finally {
      setBusy(false);
    }
  }

  // What the picture will be: the picked one, the default (removing), or the saved one.
  const pictureSrc = preview ?? (removing ? defaultpfp : undefined);
  // The banner's picture as it will be: the picked one, none (removing), or the saved one.
  const bannerSrc = banner?.preview ?? (removingBanner ? null : undefined);
  const hasBanner = banner != null || (getProfile(user.id)?.banner && !removingBanner);
  const counter = (field) => `${draft[field].length}/${PROFILE_LIMITS[field]}`;

  return (
    <div className="edit-profile">
      <div className="edit-profile-body">
        <form className="edit-profile-form" onSubmit={save} aria-label={t('settings.profile.formLabel')}>
          <div className="edit-profile-field">
            <span className="edit-profile-label">{t('settings.profile.picture')}</span>
            <div className="edit-profile-picture">
              <Avatar userId={user.id} src={pictureSrc} alt={t('settings.profile.yourPicture')} />
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => fileInput.current?.click()}>
                {t('settings.profile.changePicture')}
              </button>
              {(preview || (getProfile(user.id)?.avatar && !removing)) && (
                <button type="button" className="btn btn-sm btn-outline-danger" onClick={removePicture}>{t('common.remove')}</button>
              )}
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={pick('avatar')} aria-label={t('settings.profile.choosePicture')} />
            </div>
            <span className="vc-hint">{t('settings.profile.pictureHint')}</span>
          </div>

          <div className="edit-profile-field">
            <span className="edit-profile-label">{t('settings.profile.banner')}</span>
            <ProfileBanner userId={user.id} src={bannerSrc} color={bannerColor} className="edit-profile-banner" />
            <div className="edit-profile-picture">
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => bannerInput.current?.click()}>
                {t('settings.profile.changeBanner')}
              </button>
              {hasBanner && (
                <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => { setDone(false); setBanner(null); setRemovingBanner(true); }}>
                  {t('common.remove')}
                </button>
              )}
              <label className="edit-profile-colour">
                <input
                  type="color"
                  aria-label={t('settings.profile.bannerColour')}
                  value={colorToHex(bannerColor ?? DEFAULT_PICKER_COLOUR)}
                  onChange={(e) => changeBannerColor(parseInt(e.target.value.slice(1), 16))}
                />
                {t('settings.profile.bannerColour')}
              </label>
              {bannerColor != null && (
                <button type="button" className="btn btn-sm btn-link" onClick={() => changeBannerColor(null)}>{t('settings.profile.noColour')}</button>
              )}
              <input ref={bannerInput} type="file" accept="image/*" hidden onChange={pick('banner')} aria-label={t('settings.profile.chooseBanner')} />
            </div>
            <span className="vc-hint">{t('settings.profile.bannerHint')}</span>
          </div>

          <label className="edit-profile-field">
            <span className="edit-profile-label">{t('settings.profile.displayName')} <span className="edit-profile-count">{counter('display_name')}</span></span>
            <input
              className="form-control"
              value={draft.display_name}
              maxLength={PROFILE_LIMITS.display_name}
              placeholder={user.username}
              onChange={(e) => change('display_name', e.target.value)}
            />
            <span className="vc-hint">{t('settings.profile.displayNameHint', { username: user.username })}</span>
          </label>

          {/* Not a <label> around it all: it would label the emoji button. */}
          <div className="edit-profile-field">
            <label className="edit-profile-label" htmlFor="edit-profile-status">{t('settings.profile.customStatus')} <span className="edit-profile-count">{counter('custom_status')}</span></label>
            <div className="edit-profile-status">
              <StatusEmojiButton emoji={draft.custom_status_emoji || null} onChange={(emoji) => change('custom_status_emoji', emoji ?? '')} />
              <input
                id="edit-profile-status"
                className="form-control"
                value={draft.custom_status}
                maxLength={PROFILE_LIMITS.custom_status}
                placeholder={t('settings.profile.customStatusPlaceholder')}
                onChange={(e) => change('custom_status', e.target.value)}
              />
            </div>
          </div>

          <label className="edit-profile-field">
            <span className="edit-profile-label">{t('settings.profile.aboutMe')} <span className="edit-profile-count">{counter('bio')}</span></span>
            <textarea
              className="form-control"
              rows={4}
              value={draft.bio}
              maxLength={PROFILE_LIMITS.bio}
              placeholder={t('settings.profile.aboutMePlaceholder')}
              onChange={(e) => change('bio', e.target.value)}
            />
          </label>

          {error && <p className="error-msg" role="alert">{error}</p>}
          {done && !dirty && <p className="success-msg" role="status">{t('settings.profile.saved')}</p>}
          <div className="edit-profile-actions">
            <button type="submit" className="btn btn-sm uploadbutton" disabled={!dirty || busy}>
              {busy ? t('settings.saving') : t('common.saveChanges')}
            </button>
            <button type="button" className="btn btn-sm btn-secondary" onClick={reset} disabled={!dirty || busy}>{t('common.reset')}</button>
          </div>
        </form>

        <div className="edit-profile-preview">
          <span className="edit-profile-label">{t('settings.profile.preview')}</span>
          <div className="member-card">
            <ProfileCard
              user={{ id: user.id, username: user.username }}
              draft={{ ...Object.fromEntries(FIELDS.map((f) => [f, draft[f].trim() || null])), banner_color: bannerColor }}
              avatarSrc={pictureSrc}
              bannerSrc={bannerSrc}
            />
          </div>
        </div>
      </div>
      {cropping && (
        <ImageCropper file={cropping.file} aspect={cropping.kind === 'banner' ? BANNER_ASPECT : 1} onApply={applyCrop} onCancel={() => setCropping(null)} />
      )}
    </div>
  );
}
