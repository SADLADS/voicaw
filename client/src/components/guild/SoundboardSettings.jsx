import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../Icon';
import { faFaceSmile, faPlay, faXmark } from '@fortawesome/free-solid-svg-icons';
import EmojiPicker from '../EmojiPicker';
import { ReactionEmoji } from '../MessageReactions';
import { addSound, deleteSound, MAX_SECONDS, previewSound, updateSound, useSoundboard } from '../../voice/soundboard';
import { ACCEPT, clipFile, decodeSoundFile, fitsAsIs, soundNameFromFile, uploadType } from '../../voice/soundClip';
import { playClip } from '../../sounds/sounds';
import { getAudioSettings } from '../../voice/audioSettings';
import { reactionPickerPosition } from '../../utils/reactionPickerPosition';
import { errorMessage } from '../../utils/guildDisplay';
import { displayName } from '../../utils/profiles';
import { t } from '../../i18n';

const MAX_SOUNDS = 48;
const percent = (volume) => Math.round(volume * 100);
const seconds = (s) => (Math.round(s * 10) / 10).toFixed(1);

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

// A file picked to become a sound: its name, emoji and volume, and, when it's longer than a
// sound can be, which part (a start point; MAX_SECONDS from there).
function NewSound({ guildId, file, buffer, onDone, onCancel }) {
  const [name, setName] = useState(soundNameFromFile(file.name));
  const [emoji, setEmoji] = useState(null);
  const [volume, setVolume] = useState(1);
  const [start, setStart] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const asIs = fitsAsIs(file, buffer.duration);
  const latestStart = Math.max(0, buffer.duration - MAX_SECONDS);
  const end = Math.min(buffer.duration, start + MAX_SECONDS);

  const upload = () => (asIs ? new Blob([file], { type: uploadType(file) }) : clipFile(buffer, start));

  async function preview() {
    const url = URL.createObjectURL(upload());
    const settings = getAudioSettings();
    await playClip(url, { volume: volume * settings.soundboardVolume * settings.outputVolume, maxSeconds: MAX_SECONDS });
    setTimeout(() => URL.revokeObjectURL(url), (MAX_SECONDS + 1) * 1000);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await addSound(guildId, { name: name.trim(), emoji, volume }, upload());
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="soundboard-settings-new" role="group" aria-label={t('guildAdmin.soundboard.newSound')}>
      <div className="soundboard-settings-new-row">
        <EmojiButton emoji={emoji} label={t('guildAdmin.soundboard.chooseEmoji')} onChange={setEmoji} />
        <input
          className="form-control form-control-sm soundboard-settings-name"
          aria-label={t('guildAdmin.soundboard.name')}
          placeholder={t('guildAdmin.soundboard.name')}
          maxLength={32}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <VolumeSlider value={volume} label={t('guildAdmin.soundboard.volume')} onChange={setVolume} onCommit={() => {}} />
      </div>
      {!asIs && latestStart > 0 && (
        <label className="soundboard-settings-trim">
          <span>{t('guildAdmin.soundboard.trim', { max: MAX_SECONDS, length: seconds(buffer.duration) })}</span>
          <input
            type="range" min="0" max={latestStart} step="0.1"
            aria-label={t('guildAdmin.soundboard.trimStart')}
            aria-valuetext={t('guildAdmin.soundboard.trimRange', { from: seconds(start), to: seconds(end) })}
            value={start}
            onChange={(e) => setStart(Number(e.target.value))}
          />
          <span className="vc-hint">{t('guildAdmin.soundboard.trimRange', { from: seconds(start), to: seconds(end) })}</span>
        </label>
      )}
      {error && <p className="error-msg" role="alert">{error}</p>}
      <div className="soundboard-settings-new-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={preview}>
          <Icon icon={faPlay} /> {t('guildAdmin.soundboard.previewNew')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary btn-sm vc-button" onClick={save} disabled={busy || name.trim().length < 2}>
          {busy ? t('guildAdmin.soundboard.uploading') : t('guildAdmin.soundboard.add')}
        </button>
      </div>
    </div>
  );
}

// Guild Settings → Soundboard (Manage Emoji): the guild's sounds, added from a file (cut to
// 5.2 seconds when longer; see voice/soundClip.js), each with an emoji, a name and a volume,
// changed in place, or deleted. Everyone in the guild can play them in its voice channels.
export default function SoundboardSettings({ guild }) {
  const board = useSoundboard(guild.id);
  const [picked, setPicked] = useState(null); // { file, buffer }
  const [error, setError] = useState(null);
  const fileInput = useRef(null);

  async function pick(file) {
    setError(null);
    try {
      setPicked({ file, buffer: await decodeSoundFile(file) });
    } catch {
      setError(t('guildAdmin.soundboard.unreadable', { file: file.name }));
    }
  }

  const sounds = board?.sounds ?? [];
  return (
    <div className="soundboard-settings">
      <p className="vc-hint">{t('guildAdmin.soundboard.intro', { max: MAX_SOUNDS, seconds: MAX_SECONDS })}</p>
      {!picked && (
        <div className="vc-form-row">
          <button
            type="button"
            className="btn btn-primary btn-sm vc-button"
            disabled={sounds.length >= MAX_SOUNDS}
            onClick={() => fileInput.current?.click()}
          >
            {t('guildAdmin.soundboard.upload')}
          </button>
          <span className="vc-hint">{t('guildAdmin.soundboard.count', { used: sounds.length, max: MAX_SOUNDS })}</span>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        hidden
        aria-label={t('guildAdmin.soundboard.file')}
        onChange={(e) => {
          const [file] = e.target.files;
          e.target.value = '';
          if (file) pick(file);
        }}
      />
      {picked && (
        <NewSound
          key={picked.file.name + picked.file.size}
          guildId={guild.id}
          file={picked.file}
          buffer={picked.buffer}
          onDone={() => setPicked(null)}
          onCancel={() => setPicked(null)}
        />
      )}
      {error && <p className="error-msg" role="alert">{error}</p>}

      {board == null ? <p className="vc-hint">{t('common.loading')}</p> : sounds.length === 0 ? (
        <p className="vc-hint">{t('guildAdmin.soundboard.none')}</p>
      ) : (
        <ul className="soundboard-settings-list" aria-label={t('guildAdmin.soundboard.list')}>
          {sounds.map((sound) => <SoundRow key={sound.id} guildId={guild.id} sound={sound} onError={setError} />)}
        </ul>
      )}
    </div>
  );
}
