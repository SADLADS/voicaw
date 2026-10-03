import React, { useContext, useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { ConfigContext, LayoutContext } from '../../contexts';
import { addGuildEmoji, deleteGuildEmoji, fetchGuildEmojis, renameGuildEmoji } from '../../services/guildService';
import { customEmojiUrl } from '../../emoji/customEmoji';
import { emojiNameFromFile, errorMessage } from '../../utils/guildDisplay';
import { t } from '../../i18n';

const MAX_EMOJIS = 200;
// The server shrinks what's uploaded (to 128×128), so the original can be big.
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ['image/png', 'image/gif', 'image/webp', 'image/jpeg', 'image/avif'];

function EmojiRow({ guild, emoji, s3Endpoint, onError }) {
  const [name, setName] = useState(emoji.name);
  useEffect(() => setName(emoji.name), [emoji.name]);

  async function save() {
    if (name === emoji.name) return;
    try {
      await renameGuildEmoji(guild.id, emoji.id, name);
    } catch (err) {
      onError(errorMessage(err));
      setName(emoji.name);
    }
  }

  return (
    <li className="emoji-settings-row">
      <img className="emoji-settings-image" src={customEmojiUrl(emoji.id, s3Endpoint)} alt={`:${emoji.name}:`} />
      <label className="emoji-settings-name">
        <span aria-hidden="true">:</span>
        <input
          className="form-control form-control-sm"
          aria-label={t('guildAdmin.emoji.nameOf', { name: emoji.name })}
          maxLength={32}
          value={name}
          onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_]/g, '_'))}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setName(emoji.name);
            }
          }}
        />
        <span aria-hidden="true">:</span>
      </label>
      <span className="vc-hint emoji-settings-by">{emoji.creator_username ?? ''}</span>
      <button
        type="button"
        className="emoji-settings-delete"
        aria-label={t('guildAdmin.emoji.deleteOne', { name: emoji.name })}
        title={t('common.delete')}
        onClick={async () => {
          try {
            await deleteGuildEmoji(guild.id, emoji.id);
          } catch (err) {
            onError(errorMessage(err));
          }
        }}
      >
        <FontAwesomeIcon icon={faXmark} />
      </button>
    </li>
  );
}

// Guild Settings → Emoji (Manage Emoji): upload (named from the file, renamed in place) and
// delete the guild's custom emoji. Everyone in the guild can use them, anywhere.
export default function EmojiSettings({ guild }) {
  const { s3Endpoint } = useContext(ConfigContext);
  const { guildList } = useContext(LayoutContext);
  const live = guildList.emojis[guild.id];
  const [emojis, setEmojis] = useState(null);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState(null);
  const fileInput = useRef(null);

  // The list with who added each; fetched again whenever the guild's emoji change.
  useEffect(() => {
    fetchGuildEmojis(guild.id).then(setEmojis).catch((err) => setError(errorMessage(err)));
  }, [guild.id, live]);

  async function upload(files) {
    setError(null);
    for (const file of files) {
      if (!TYPES.includes(file.type)) {
        setError(t('guildAdmin.emoji.wrongType', { file: file.name }));
        continue;
      }
      if (file.size > MAX_BYTES) {
        setError(t('guildAdmin.emoji.tooBig', { file: file.name }));
        continue;
      }
      setUploading((n) => n + 1);
      try {
        await addGuildEmoji(guild.id, emojiNameFromFile(file.name), file);
      } catch (err) {
        setError(t('guildAdmin.emoji.uploadFailed', { file: file.name, error: errorMessage(err) }));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  const count = emojis?.length ?? 0;
  return (
    <div className="emoji-settings">
      <p className="vc-hint">{t('guildAdmin.emoji.intro', { max: MAX_EMOJIS })}</p>
      <div className="vc-form-row">
        <button
          type="button"
          className="btn btn-primary btn-sm vc-button"
          disabled={count >= MAX_EMOJIS}
          onClick={() => fileInput.current?.click()}
        >
          {t('guildAdmin.emoji.upload')}
        </button>
        <span className="vc-hint">
          {uploading
            ? t('guildAdmin.emoji.countUploading', { used: count, max: MAX_EMOJIS, uploading })
            : t('guildAdmin.emoji.count', { used: count, max: MAX_EMOJIS })}
        </span>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept={TYPES.join(',')}
        multiple
        hidden
        aria-label={t('guildAdmin.emoji.images')}
        onChange={(e) => {
          const files = [...e.target.files];
          e.target.value = '';
          upload(files);
        }}
      />
      {error && <p className="error-msg" role="alert">{error}</p>}

      {emojis == null ? <p className="vc-hint">{t('common.loading')}</p> : emojis.length === 0 ? (
        <p className="vc-hint">{t('guildAdmin.emoji.none')}</p>
      ) : (
        <ul className="emoji-settings-list" aria-label={t('guildAdmin.emoji.list')}>
          {emojis.map((emoji) => (
            <EmojiRow key={emoji.id} guild={guild} emoji={emoji} s3Endpoint={s3Endpoint} onError={setError} />
          ))}
        </ul>
      )}
    </div>
  );
}
