import React, { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCamera, faImage, faPen, faTrash } from '@fortawesome/free-solid-svg-icons';
import { ImageViewerContext, InteractionContext } from '../contexts';
import Avatar from './Avatar';
import StatusIcon from './StatusIcon';
import CustomStatus from './CustomStatus';
import Activities from './Activities';
import ProfileBanner from './ProfileBanner';
import StatusEmojiButton from './StatusEmojiButton';
import ImageCropper from './ImageCropper';
import GuildIcon from './guild/GuildIcon';
import { usePresence } from '../hooks/usePresence';
import { useSheetDismiss } from '../hooks/useSheetDismiss';
import { avatarUrl, getProfile, mergeProfiles, nameOf, PROFILE_LIMITS, useProfiles } from '../utils/profiles';
import { lastSeenText, statusLabel } from '../utils/presence';
import { colorToHex } from '../utils/permissions';
import { formatDate, formatRelative } from '../utils/dateFormat';
import { galleryItemFromUrl } from '../utils/imageGallery';
import {
  fetchUserProfile, pictureFileError, removeBanner, removeProfilePicture, updateProfile, uploadBanner, uploadProfilePicture,
} from '../services/profileService';
import { t } from '../i18n';

const BANNER_ASPECT = 2.5; // 5:2, server/avatarImage.js processBanner
// What the colour picker starts at before a colour is chosen (the app's accent).
const DEFAULT_PICKER_COLOUR = 0x6a52c9;
const errorText = (err) => err?.response?.data?.error || err?.message || t('settings.savingFailed');

// How long, in words: "45 min", "3 h 20 min".
function playTime(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return t('app.profile.playTimeMinutes', { minutes });
  return t('app.profile.playTimeHours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

// Someone's full profile (Discord's), over everything: a bigger banner and picture (the picture
// opens in the image viewer, to see it whole or save it), names, status, custom status, then
// tabs: About me (bio, when they joined Voicaw), Activity (what they're playing now and the
// games they played in the last 30 days, server/activityHistory.js), Mutual friends and Mutual
// guilds. A tab they hide (Settings → Privacy) isn't there. Opened from a profile card's
// picture or names (utils/userProfile.js); a mutual friend opens theirs in its place
// (`onOpenProfile`), a mutual guild goes there.
// Yours (`me`) is edited in place, each part saved at once: picture and banner picture (through
// the cropper), banner colour, display name, custom status (and its emoji) and about me (what
// Settings' Edit Profile page had: it's opened from there now, and from the user menu);
// Activity says when it's hidden from others or off.
// On a phone it's a full-screen sheet, as the emoji panel pulled up, with its handle: swiping
// it down (from the top of what's scrolled) closes it (useSheetDismiss), as does the handle.
export default function UserProfile({ userId, me, onClose, onOpenProfile }) {
  useProfiles();
  const presenceOf = usePresence();
  const navigate = useNavigate();
  const viewer = useContext(ImageViewerContext);
  const { isMobile } = useContext(InteractionContext);
  const sheetRef = useRef(null);
  useSheetDismiss({ sheetRef, enabled: isMobile, onClose });
  const own = String(userId) === String(me);
  const profile = getProfile(userId) ?? { id: userId };
  const presence = presenceOf(profile);
  const name = nameOf(profile);
  const [data, setData] = useState(null); // GET /users/:id/profile
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState('about');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    setTab('about');
    fetchUserProfile(userId).then((found) => {
      if (cancelled) return;
      mergeProfiles(found.mutualFriends ?? []);
      setData(found);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const picture = avatarUrl(userId);
  const viewPicture = () => {
    if (picture) viewer?.openImage({ images: [galleryItemFromUrl(picture, `${name}.webp`)], index: 0 });
  };

  const tabs = [
    ['about', t('app.profile.tabAbout')],
    data?.activity != null && ['activity', t('app.profile.tabActivity')],
    // Shorter on a phone, so all four fit.
    data?.mutualFriends != null && ['friends', t(isMobile ? 'app.profile.tabFriendsShort' : 'app.profile.tabFriendsCount', { count: data.mutualFriends.length })],
    data?.mutualGuilds != null && ['guilds', t(isMobile ? 'app.profile.tabGuildsShort' : 'app.profile.tabGuildsCount', { count: data.mutualGuilds.length })],
  ].filter(Boolean);

  return createPortal(
    <div className="vc-dialog-backdrop user-profile-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={sheetRef}
        className={`user-profile${isMobile ? ' sheet' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('app.profile.profileOf', { name })}
        data-user-id={userId}
      >
        {isMobile && <button type="button" className="user-profile-handle" aria-label={t('common.close')} onClick={onClose} />}
        <button type="button" className="vc-dialog-close user-profile-close" aria-label={t('common.close')} onClick={onClose}>×</button>
        {own ? <OwnBanner userId={userId} /> : <ProfileBanner userId={userId} className="user-profile-banner" />}
        <div className="user-profile-head">
          <span className="user-profile-avatar status-avatar">
            {picture ? (
              <button type="button" className="user-profile-avatar-view" aria-label={t('app.profile.viewPicture')} onClick={viewPicture}>
                <Avatar userId={userId} alt={t('app.profile.picture', { name })} />
              </button>
            ) : <Avatar userId={userId} alt={t('app.profile.picture', { name })} />}
            <StatusIcon status={presence.status} />
          </span>
          {/* Beside the picture, not in it: everything in a .status-avatar but its icon is masked. */}
          {own && <OwnPictureButtons userId={userId} />}
        </div>
        <div className="user-profile-names">
          {own ? <OwnName userId={userId} name={name} /> : <h4 className="user-profile-name">{name}</h4>}
          {profile.display_name && <div className="profile-card-username">{profile.username}</div>}
          <div className={`profile-card-presence ${presence.status}`}>
            {presence.status === 'offline' ? lastSeenText(presence.lastOnline) ?? statusLabel('offline') : statusLabel(presence.status)}
          </div>
          {own ? <OwnStatus userId={userId} /> : <CustomStatus profile={profile} className="profile-card-custom-status" />}
        </div>

        <div className="user-profile-tabs" role="tablist" aria-label={t('app.profile.tabs')}>
          {tabs.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`user-profile-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="user-profile-panel" role="tabpanel">
          {tab === 'about' && (
            <>
              {own ? <OwnBio userId={userId} /> : (
                profile.bio
                  ? <p className="profile-card-bio">{profile.bio}</p>
                  : <p className="vc-hint">{t('app.profile.noBio')}</p>
              )}
              {data?.memberSince ? (
                <div className="user-profile-since">
                  <div className="member-card-label">{t('app.profile.memberSince')}</div>
                  <div>{formatDate(data.memberSince * 1000)}</div>
                </div>
              ) : null}
            </>
          )}
          {tab === 'activity' && data?.activity && <ActivityTab userId={userId} games={data.activity} own={own} hidden={data.hidden?.activity} />}
          {tab === 'friends' && data?.mutualFriends && (
            data.mutualFriends.length ? (
              <ul className="user-profile-list">
                {data.mutualFriends.map((friend) => (
                  <li key={friend.id}>
                    <button type="button" className="user-profile-row" data-user-id={friend.id} onClick={() => onOpenProfile(friend.id)}>
                      <span className="user-profile-row-avatar status-avatar">
                        <Avatar userId={friend.id} />
                        <StatusIcon status={presenceOf(friend).status} />
                      </span>
                      <span className="user-profile-row-name">{nameOf(getProfile(friend.id) ?? friend)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="vc-hint">{t('app.profile.noMutualFriends')}</p>
          )}
          {tab === 'guilds' && data?.mutualGuilds && (
            data.mutualGuilds.length ? (
              <ul className="user-profile-list">
                {data.mutualGuilds.map((guild) => (
                  <li key={guild.id}>
                    <button type="button" className="user-profile-row" onClick={() => { onClose(); navigate(`/guild/${guild.id}`); }}>
                      <GuildIcon guild={guild} className="user-profile-row-avatar" />
                      <span className="user-profile-row-name">{guild.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="vc-hint">{t('app.profile.noMutualGuilds')}</p>
          )}
          {!data && (failed
            ? <p className="error-msg" role="alert">{t('app.profile.loadFailed')}</p>
            : <p className="vc-hint">{t('app.profile.loading')}</p>)}
        </div>
      </div>
    </div>,
    document.body
  );
}

// The Activity tab: what they're playing now (as on their card), then each game of the last 30
// days with its time in all and when it was last played.
function ActivityTab({ userId, games, own, hidden }) {
  return (
    <>
      <Activities userId={userId} />
      {own && hidden && <p className="vc-hint">{t('app.profile.activityOff')}</p>}
      {own && !hidden && <p className="vc-hint">{t('app.profile.activityHint')}</p>}
      {games.length ? (
        <ul className="user-profile-games">
          {games.map((game) => (
            <li key={game.name} className="user-profile-game">
              <span className="user-profile-game-name">{game.name}</span>
              <span className="user-profile-game-time">{playTime(game.seconds)}</span>
              <span className="vc-hint">
                {game.playing ? t('app.profile.playingNow') : t('app.profile.lastPlayed', { when: formatRelative(game.lastPlayed * 1000) })}
              </span>
            </li>
          ))}
        </ul>
      ) : (!own || !hidden) && <p className="vc-hint">{t('app.profile.noActivity')}</p>}
    </>
  );
}

// Picks an image and crops it (`aspect`), then hands it to `upload(file, crop)`; errors shown.
function usePictureUpload(upload, aspect = 1) {
  const input = useRef(null);
  const [cropping, setCropping] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pick = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const problem = pictureFileError(file);
    setError(problem);
    if (!problem) setCropping(file);
  };
  const run = async (action) => {
    setBusy(true);
    setError(null);
    try {
      mergeProfiles([await action()]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const cropper = cropping && (
    <ImageCropper
      file={cropping}
      aspect={aspect}
      onCancel={() => setCropping(null)}
      onApply={(crop) => { const file = cropping; setCropping(null); run(() => upload(file, crop)); }}
    />
  );
  const fileInput = (label) => <input ref={input} type="file" accept="image/*" hidden onChange={pick} aria-label={label} />;
  return { choose: () => input.current?.click(), run, busy, error, cropper, fileInput };
}

// Your banner, with buttons to change its picture, its colour, or remove the picture.
function OwnBanner({ userId }) {
  const profile = getProfile(userId);
  const upload = usePictureUpload(uploadBanner, BANNER_ASPECT);
  const [colour, setColour] = useState(null); // while picking, before it's saved
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  // The colour input fires as it's dragged: saved once it rests.
  const pickColour = (hex) => {
    const value = parseInt(hex.slice(1), 16);
    setColour(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => upload.run(() => updateProfile({ bannerColor: value })).then(() => setColour(null)), 600);
  };
  const shown = colour ?? profile?.banner_color;
  return (
    <ProfileBanner userId={userId} color={colour ?? undefined} className="user-profile-banner">
      <div className="user-profile-banner-edit">
        <button type="button" className="user-profile-edit-button" title={t('app.profile.changeBanner')} aria-label={t('app.profile.changeBanner')} disabled={upload.busy} onClick={upload.choose}>
          <FontAwesomeIcon icon={faImage} />
        </button>
        <label className="user-profile-edit-button user-profile-colour" title={t('app.profile.bannerColour')}>
          <input type="color" aria-label={t('app.profile.bannerColour')} value={colorToHex(shown ?? DEFAULT_PICKER_COLOUR)} onChange={(e) => pickColour(e.target.value)} />
        </label>
        {profile?.banner && (
          <button type="button" className="user-profile-edit-button" title={t('app.profile.removeBanner')} aria-label={t('app.profile.removeBanner')} disabled={upload.busy} onClick={() => upload.run(removeBanner)}>
            <FontAwesomeIcon icon={faTrash} />
          </button>
        )}
        {upload.fileInput(t('settings.profile.chooseBanner'))}
      </div>
      {upload.error && <p className="error-msg user-profile-banner-error" role="alert">{upload.error}</p>}
      {upload.cropper}
    </ProfileBanner>
  );
}

// On your picture: change it (cropper) or go back to the default one.
function OwnPictureButtons({ userId }) {
  const upload = usePictureUpload(uploadProfilePicture);
  return (
    <>
      <button type="button" className="user-profile-edit-button user-profile-picture-change" title={t('app.profile.changePicture')} aria-label={t('app.profile.changePicture')} disabled={upload.busy} onClick={upload.choose}>
        <FontAwesomeIcon icon={faCamera} />
      </button>
      {getProfile(userId)?.avatar && (
        <button type="button" className="user-profile-edit-button user-profile-picture-remove" title={t('app.profile.removePicture')} aria-label={t('app.profile.removePicture')} disabled={upload.busy} onClick={() => upload.run(removeProfilePicture)}>
          <FontAwesomeIcon icon={faTrash} />
        </button>
      )}
      {upload.fileInput(t('settings.profile.choosePicture'))}
      {upload.error && <p className="error-msg user-profile-picture-error" role="alert">{upload.error}</p>}
      {upload.cropper}
    </>
  );
}

// Your display name: shown with a pencil, or edited (empty: your username; Enter or Save,
// Escape or Cancel).
function OwnName({ userId, name }) {
  const profile = getProfile(userId) ?? {};
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      mergeProfiles([await updateProfile({ displayName: editing.trim() })]);
      setEditing(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  if (editing == null) {
    return (
      <div className="user-profile-editable">
        <h4 className="user-profile-name">{name}</h4>
        <button
          type="button"
          className="user-profile-edit-inline"
          aria-label={t('app.profile.editName')}
          title={t('app.profile.editName')}
          onClick={() => setEditing(profile.display_name ?? '')}
        >
          <FontAwesomeIcon icon={faPen} />
        </button>
      </div>
    );
  }
  return (
    <div className="user-profile-name-edit">
      <div className="user-profile-status-edit">
        <input
          className="form-control form-control-sm"
          aria-label={t('settings.profile.displayName')}
          placeholder={profile.username}
          maxLength={PROFILE_LIMITS.display_name}
          value={editing}
          autoFocus
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
            if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
          }}
        />
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>{busy ? t('app.profile.saving') : t('common.save')}</button>
        <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => setEditing(null)}>{t('common.cancel')}</button>
      </div>
      <p className="vc-hint">{t('settings.profile.displayNameHint', { username: profile.username })}</p>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>
  );
}

// Your custom status: shown with a pencil, or edited (emoji, text; Enter or Save, Escape or Cancel).
function OwnStatus({ userId }) {
  const profile = getProfile(userId) ?? {};
  const [editing, setEditing] = useState(null); // { text, emoji } while editing
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      mergeProfiles([await updateProfile({ customStatus: editing.text.trim(), customStatusEmoji: editing.emoji ?? '' })]);
      setEditing(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  if (!editing) {
    const has = profile.custom_status || profile.custom_status_emoji;
    return (
      <div className="user-profile-editable">
        {has && <CustomStatus profile={profile} className="profile-card-custom-status" />}
        <button
          type="button"
          className={has ? 'user-profile-edit-inline' : 'user-profile-add'}
          aria-label={t('app.profile.editStatus')}
          title={t('app.profile.editStatus')}
          onClick={() => setEditing({ text: profile.custom_status ?? '', emoji: profile.custom_status_emoji ?? null })}
        >
          {has ? <FontAwesomeIcon icon={faPen} /> : t('app.profile.setStatus')}
        </button>
      </div>
    );
  }
  return (
    <div className="user-profile-status-edit">
      <StatusEmojiButton emoji={editing.emoji} onChange={(emoji) => setEditing((e) => ({ ...e, emoji: emoji ?? null }))} />
      <input
        className="form-control form-control-sm"
        aria-label={t('settings.profile.customStatus')}
        placeholder={t('settings.profile.customStatusPlaceholder')}
        maxLength={PROFILE_LIMITS.custom_status}
        value={editing.text}
        autoFocus
        onChange={(e) => setEditing((s) => ({ ...s, text: e.target.value }))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
        }}
      />
      <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>{busy ? t('app.profile.saving') : t('common.save')}</button>
      <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => setEditing(null)}>{t('common.cancel')}</button>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>
  );
}

// Your about me: shown with a pencil, or edited in a box (Save / Cancel; Escape cancels).
function OwnBio({ userId }) {
  const bio = getProfile(userId)?.bio ?? '';
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      mergeProfiles([await updateProfile({ bio: editing })]);
      setEditing(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  if (editing == null) {
    return (
      <div className="user-profile-editable">
        {bio && <p className="profile-card-bio">{bio}</p>}
        <button
          type="button"
          className={bio ? 'user-profile-edit-inline' : 'user-profile-add'}
          aria-label={t('app.profile.editBio')}
          title={t('app.profile.editBio')}
          onClick={() => setEditing(bio)}
        >
          {bio ? <FontAwesomeIcon icon={faPen} /> : t('app.profile.addBio')}
        </button>
      </div>
    );
  }
  return (
    <div className="user-profile-bio-edit">
      <textarea
        className="form-control"
        rows={4}
        aria-label={t('settings.profile.aboutMe')}
        placeholder={t('settings.profile.aboutMePlaceholder')}
        maxLength={PROFILE_LIMITS.bio}
        value={editing}
        autoFocus
        onChange={(e) => setEditing(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setEditing(null); } }}
      />
      <div className="user-profile-edit-actions">
        <span className="vc-hint">{editing.length}/{PROFILE_LIMITS.bio}</span>
        <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => setEditing(null)}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>{busy ? t('app.profile.saving') : t('common.save')}</button>
      </div>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>
  );
}
