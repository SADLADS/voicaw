import React, { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import { faCamera, faImage, faTrash, faXmark } from '@fortawesome/free-solid-svg-icons';
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
// the cropper), banner colour, and display name, custom status (its emoji button and text, as in
// the user menu) and about me, each edited by clicking it (InlineText) (what Settings' Edit
// Profile page had: it's opened from there now, and from the user menu);
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
        <button type="button" className="vc-dialog-close user-profile-close" aria-label={t('common.close')} onClick={onClose}>
          <Icon icon={faXmark} />
        </button>
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
          {own ? <OwnName userId={userId} /> : <h4 className="user-profile-name">{name}</h4>}
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
          <Icon icon={faImage} />
        </button>
        <label className="user-profile-edit-button user-profile-colour" title={t('app.profile.bannerColour')}>
          <input type="color" aria-label={t('app.profile.bannerColour')} value={colorToHex(shown ?? DEFAULT_PICKER_COLOUR)} onChange={(e) => pickColour(e.target.value)} />
        </label>
        {profile?.banner && (
          <button type="button" className="user-profile-edit-button" title={t('app.profile.removeBanner')} aria-label={t('app.profile.removeBanner')} disabled={upload.busy} onClick={() => upload.run(removeBanner)}>
            <Icon icon={faTrash} />
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
        <Icon icon={faCamera} />
      </button>
      {getProfile(userId)?.avatar && (
        <button type="button" className="user-profile-edit-button user-profile-picture-remove" title={t('app.profile.removePicture')} aria-label={t('app.profile.removePicture')} disabled={upload.busy} onClick={() => upload.run(removeProfilePicture)}>
          <Icon icon={faTrash} />
        </button>
      )}
      {upload.fileInput(t('settings.profile.choosePicture'))}
      {upload.error && <p className="error-msg user-profile-picture-error" role="alert">{upload.error}</p>}
      {upload.cropper}
    </>
  );
}

// A text of your profile that's edited where it's shown (no pencil, no Save): it looks like the
// text until clicked; Enter (or Ctrl+Enter when `multiline`, where Enter is a new line) or
// clicking away saves it, Escape puts it back. `onSave(text)` resolves once saved (errors shown).
function InlineText({ value, onSave, multiline = false, className = '', label, placeholder, maxLength, title }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState(null);
  const cancelled = useRef(false);
  const ref = useRef(null);
  // Follows the saved text (here or from another device) unless it's being edited.
  useEffect(() => { if (!focused) setDraft(value); }, [value, focused]);
  // A multi-line box grows with its text.
  useEffect(() => {
    const box = ref.current;
    if (!multiline || !box) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight}px`;
  }, [multiline, draft]);

  const commit = async () => {
    setFocused(false);
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(value);
      return;
    }
    const text = multiline ? draft.trim().replace(/\n{3,}/g, '\n\n') : draft.trim();
    if (text === (value ?? '').trim()) return;
    setError(null);
    try {
      await onSave(text);
    } catch (err) {
      setError(errorText(err));
      setDraft(value);
    }
  };
  const Field = multiline ? 'textarea' : 'input';
  return (
    <>
      <Field
        ref={ref}
        className={`user-profile-inline ${className}`}
        aria-label={label}
        title={title}
        placeholder={placeholder}
        maxLength={maxLength}
        rows={multiline ? 1 : undefined}
        value={draft}
        spellCheck={multiline}
        onFocus={() => setFocused(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cancelled.current = true;
            e.currentTarget.blur();
          } else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      {error && <p className="error-msg" role="alert">{error}</p>}
    </>
  );
}

// Your display name, edited where it's shown (empty: your username, its placeholder).
function OwnName({ userId }) {
  const profile = getProfile(userId) ?? {};
  return (
    <InlineText
      className="user-profile-name"
      label={t('settings.profile.displayName')}
      title={t('settings.profile.displayNameHint', { username: profile.username })}
      placeholder={profile.username}
      maxLength={PROFILE_LIMITS.display_name}
      value={profile.display_name ?? ''}
      onSave={async (text) => mergeProfiles([await updateProfile({ displayName: text })])}
    />
  );
}

// Your custom status, as the user menu has it: the emoji button (a pick saves at once) and the
// text, edited where it's shown.
function OwnStatus({ userId }) {
  const profile = getProfile(userId) ?? {};
  const [error, setError] = useState(null);
  const save = async (changes) => mergeProfiles([await updateProfile(changes)]);
  return (
    <div className="user-profile-status">
      <StatusEmojiButton
        emoji={profile.custom_status_emoji ?? null}
        onChange={(emoji) => {
          setError(null);
          save({ customStatusEmoji: emoji ?? '' }).catch((err) => setError(errorText(err)));
        }}
      />
      <InlineText
        className="user-profile-status-text"
        label={t('settings.profile.customStatus')}
        placeholder={t('app.profile.setStatus')}
        maxLength={PROFILE_LIMITS.custom_status}
        value={profile.custom_status ?? ''}
        onSave={(text) => save({ customStatus: text })}
      />
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>
  );
}

// Your about me, edited where it's shown (new lines allowed: clicking away saves).
function OwnBio({ userId }) {
  return (
    <InlineText
      multiline
      className="profile-card-bio"
      label={t('settings.profile.aboutMe')}
      placeholder={t('app.profile.addBio')}
      maxLength={PROFILE_LIMITS.bio}
      value={getProfile(userId)?.bio ?? ''}
      onSave={async (text) => mergeProfiles([await updateProfile({ bio: text })])}
    />
  );
}
