import React, { useContext, useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { ConfigContext, LayoutContext } from '../../contexts';
import { addGuildEmoji, deleteGuildEmoji, fetchGuildEmojis, renameGuildEmoji } from '../../services/guildService';
import { customEmojiUrl } from '../../emoji/customEmoji';
import { emojiNameFromFile, errorMessage } from '../../utils/guildDisplay';

const MAX_EMOJIS = 50;
const MAX_BYTES = 256 * 1024;
const TYPES = ['image/png', 'image/gif', 'image/webp', 'image/jpeg'];

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
          aria-label={`Name of :${emoji.name}:`}
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
        aria-label={`Delete :${emoji.name}:`}
        title="Delete"
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

// Server Settings → Emoji (Manage Emoji): upload (named from the file, renamed in place) and
// delete the server's custom emoji. Everyone in the server can use them, anywhere.
export default function EmojiSettings({ guild }) {
  const { s3Endpoint } = useContext(ConfigContext);
  const { guildList } = useContext(LayoutContext);
  const live = guildList.emojis[guild.id];
  const [emojis, setEmojis] = useState(null);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState(null);
  const fileInput = useRef(null);

  // The list with who added each; fetched again whenever the server's emoji change.
  useEffect(() => {
    fetchGuildEmojis(guild.id).then(setEmojis).catch((err) => setError(errorMessage(err)));
  }, [guild.id, live]);

  async function upload(files) {
    setError(null);
    for (const file of files) {
      if (!TYPES.includes(file.type)) {
        setError(`${file.name}: emoji must be PNG, GIF, WebP or JPEG images.`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        setError(`${file.name} is over 256 KB.`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        await addGuildEmoji(guild.id, emojiNameFromFile(file.name), file);
      } catch (err) {
        setError(`${file.name}: ${errorMessage(err)}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  const count = emojis?.length ?? 0;
  return (
    <div className="emoji-settings">
      <p className="vc-hint">
        Add up to {MAX_EMOJIS} custom emoji anyone in the server can use. PNG, GIF, WebP or JPEG, under 256 KB;
        names are letters, numbers and underscores. 128×128 looks best.
      </p>
      <div className="vc-form-row">
        <button
          type="button"
          className="btn btn-primary btn-sm vc-button"
          disabled={count >= MAX_EMOJIS}
          onClick={() => fileInput.current?.click()}
        >
          Upload Emoji
        </button>
        <span className="vc-hint">{count} / {MAX_EMOJIS}{uploading ? ` · uploading ${uploading}…` : ''}</span>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept={TYPES.join(',')}
        multiple
        hidden
        aria-label="Emoji images"
        onChange={(e) => {
          const files = [...e.target.files];
          e.target.value = '';
          upload(files);
        }}
      />
      {error && <p className="error-msg" role="alert">{error}</p>}

      {emojis == null ? <p className="vc-hint">Loading…</p> : emojis.length === 0 ? (
        <p className="vc-hint">No custom emoji yet.</p>
      ) : (
        <ul className="emoji-settings-list" aria-label="Custom emoji">
          {emojis.map((emoji) => (
            <EmojiRow key={emoji.id} guild={guild} emoji={emoji} s3Endpoint={s3Endpoint} onError={setError} />
          ))}
        </ul>
      )}
    </div>
  );
}
