import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../Icon';
import { faFaceSmile, faPlay, faXmark } from '@fortawesome/free-solid-svg-icons';
import EmojiPicker from '../EmojiPicker';
import { ReactionEmoji } from '../MessageReactions';
import { addSound, deleteSound, MAX_SECONDS, previewSound, updateSound, useSoundboard } from '../../voice/soundboard';
import { ACCEPT, soundNameFromFile, soundUpload } from '../../voice/soundClip';
import { reactionPickerPosition } from '../../utils/reactionPickerPosition';
import { errorMessage } from '../../utils/guildDisplay';
import { displayName } from '../../utils/profiles';
import { t } from '../../i18n';

const MAX_SOUNDS = 48;
const percent = (volume) => Math.round(volume * 100);

// The emoji picker by a button, while `picking` (its rect) is set.
function useEmojiPicker() {
  const [picking, setPicking] = useState(null);
  const close = useCallback(() => setPicking(null), []);
  const toggle = (button) => {
    if (picking) return setPicking(null);
    const { top, bottom, left, right } = button.getBoundingClientRect();
    setPicking({ top, bottom, left, right });
  };
  const render = (onSelect) => {
    if (!picking) return null;
    const place = reactionPickerPosition(picking);
    return createPortal(
      <div className={`reaction-picker-anchor event-emoji-anchor${place.below ? ' below' : ''}`} style={place.style}>
        <EmojiPicker autoFocus={false} onSelect={(emoji) => { onSelect(emoji); close(); }} onClose={close} />
      </div>,
      document.body
    );
  };
  return { open: Boolean(picking), toggle, render };
}

function EmojiButton({ emoji, onChange, label }) {
  const picker = useEmojiPicker();
  return (
    <>
      <button
        type="button"
        className="soundboard-settings-emoji"
        aria-label={label}
        title={label}
        aria-expanded={picker.open}
        // Don't let the open picker's outside-click handler close it before this toggles.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => picker.toggle(e.currentTarget)}
      >
        {emoji ? <ReactionEmoji native={emoji} /> : <Icon icon={faFaceSmile} />}
      </button>
      {picker.render(onChange)}
    </>
  );
}

function VolumeSlider({ value, onChange, onCommit, label }) {
  return (
    <span className="sound-volume soundboard-settings-volume">
      <input
        type="range" min="0" max="100" step="1"
        aria-label={label}
        value={percent(value)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
      />
      <span className="sound-volume-value">{percent(value)}%</span>
    </span>
  );
}

function SoundRow({ guildId, sound, onError }) {
  const [name, setName] = useState(sound.name);
  const [volume, setVolume] = useState(sound.volume);
  useEffect(() => setName(sound.name), [sound.name]);
  useEffect(() => setVolume(sound.volume), [sound.volume]);

  async function save(changes) {
    try {
      await updateSound(guildId, sound.id, changes);
    } catch (err) {
      onError(errorMessage(err));
      setName(sound.name);
      setVolume(sound.volume);
    }
  }

  return (
    <li className="soundboard-settings-row">
      <button
        type="button"
        className="soundboard-settings-play"
        aria-label={t('voice.soundboard.preview', { name: sound.name })}
        title={t('voice.soundboard.preview', { name: sound.name })}
        onClick={() => previewSound({ ...sound, volume })}
      >
        <Icon icon={faPlay} />
      </button>
      <EmojiButton
        emoji={sound.emoji}
        label={t('guildAdmin.soundboard.emojiOf', { name: sound.name })}
        onChange={(emoji) => save({ emoji })}
      />
      <input
        className="form-control form-control-sm soundboard-settings-name"
        aria-label={t('guildAdmin.soundboard.nameOf', { name: sound.name })}
        maxLength={32}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => { if (name.trim() !== sound.name) save({ name }); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setName(sound.name);
          }
        }}
      />
      <VolumeSlider
        value={volume}
        label={t('guildAdmin.soundboard.volumeOf', { name: sound.name })}
        onChange={setVolume}
        onCommit={() => { if (volume !== sound.volume) save({ volume }); }}
      />
      <span className="vc-hint soundboard-settings-by">{displayName(sound.creator_id, '')}</span>
      {sound.emoji && (
        <button type="button" className="btn btn-link btn-sm soundboard-settings-clear" onClick={() => save({ emoji: null })}>
          {t('guildAdmin.soundboard.removeEmoji')}
        </button>
      )}
      <button
        type="button"
        className="emoji-settings-delete"
        aria-label={t('guildAdmin.soundboard.deleteOne', { name: sound.name })}
        title={t('common.delete')}
        onClick={async () => {
          try {
            await deleteSound(guildId, sound.id);
          } catch (err) {
            onError(errorMessage(err));
          }
        }}
      >
        <Icon icon={faXmark} />
      </button>
    </li>
  );
}

// Guild Settings → Soundboard (Manage Emoji): the guild's sounds, added from files (several at
// once, each uploaded as soon as it's picked, named after its file, and cut to 5.2 seconds from
// where its sound starts when longer; see voice/soundClip.js), each with an emoji, a name and a
// volume, changed in place, or deleted. Everyone in the guild can play them in its voice channels.
export default function SoundboardSettings({ guild }) {
  const board = useSoundboard(guild.id);
  const [progress, setProgress] = useState(null); // { done, total } while uploading
  const [errors, setErrors] = useState([]);
  const fileInput = useRef(null);
  const sounds = board?.sounds ?? [];

  async function addFiles(files) {
    const room = Math.max(0, MAX_SOUNDS - sounds.length);
    const adding = files.slice(0, room);
    const failed = files.length > room ? [t('guildAdmin.soundboard.full', { count: files.length - room, max: MAX_SOUNDS })] : [];
    setErrors([]);
    for (const [i, file] of adding.entries()) {
      setProgress({ done: i, total: adding.length });
      let upload;
      try {
        upload = await soundUpload(file);
      } catch {
        failed.push(t('guildAdmin.soundboard.unreadable', { file: file.name }));
        continue;
      }
      try {
        await addSound(guild.id, { name: soundNameFromFile(file.name) }, upload);
      } catch (err) {
        failed.push(t('guildAdmin.soundboard.failed', { file: file.name, error: errorMessage(err) }));
      }
    }
    setProgress(null);
    setErrors(failed);
  }

  const showError = useCallback((message) => setErrors([message]), []);
  return (
    <div className="soundboard-settings">
      <p className="vc-hint">{t('guildAdmin.soundboard.intro', { max: MAX_SOUNDS, seconds: MAX_SECONDS })}</p>
      <div className="vc-form-row">
        <button
          type="button"
          className="btn btn-primary btn-sm vc-button"
          disabled={progress != null || sounds.length >= MAX_SOUNDS}
          onClick={() => fileInput.current?.click()}
        >
          {progress
            ? t('guildAdmin.soundboard.uploading', { current: progress.done + 1, total: progress.total })
            : t('guildAdmin.soundboard.upload')}
        </button>
        <span className="vc-hint">{t('guildAdmin.soundboard.count', { used: sounds.length, max: MAX_SOUNDS })}</span>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        aria-label={t('guildAdmin.soundboard.file')}
        onChange={(e) => {
          const files = [...e.target.files];
          e.target.value = '';
          if (files.length) addFiles(files);
        }}
      />
      {errors.map((message, i) => <p key={i} className="error-msg" role="alert">{message}</p>)}

      {board == null ? <p className="vc-hint">{t('common.loading')}</p> : sounds.length === 0 ? (
        <p className="vc-hint">{t('guildAdmin.soundboard.none')}</p>
      ) : (
        <ul className="soundboard-settings-list" aria-label={t('guildAdmin.soundboard.list')}>
          {sounds.map((sound) => <SoundRow key={sound.id} guildId={guild.id} sound={sound} onError={showError} />)}
        </ul>
      )}
    </div>
  );
}
