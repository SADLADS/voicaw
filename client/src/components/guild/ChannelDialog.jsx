import React, { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHashtag, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import Modal from './Modal';
import { createChannel, deleteChannel, updateChannel } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';

// Creating a channel (no `channel`; in `categoryId` if given) or editing one (name, topic,
// category, delete). Owner only; the server checks.
export default function ChannelDialog({ guild, channel, categoryId = null, onCreated, onClose }) {
  const editing = Boolean(channel);
  const [type, setType] = useState(channel?.type ?? 'text');
  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [category, setCategory] = useState(editing ? channel.category_id : categoryId);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function save(e) {
    e.preventDefault();
    if (!name.trim()) return;
    run(async () => {
      if (editing) {
        await updateChannel(guild.id, channel.id, { name, topic: topic.trim() || null, categoryId: category });
      } else {
        const created = await createChannel(guild.id, { name, type, topic: topic.trim() || null, categoryId: category });
        onCreated?.(created);
      }
    });
  }

  // Shown as it will be saved: lower case, spaces as dashes.
  const preview = name.trim().toLowerCase().replace(/\s+/g, '-');

  return (
    <Modal
      title={editing ? `Edit #${channel.name}` : 'Create channel'}
      onClose={onClose}
      actions={(
        <>
          {editing && !confirmingDelete && (
            <button type="button" className="btn btn-outline-danger btn-sm me-auto" onClick={() => setConfirmingDelete(true)}>
              Delete channel
            </button>
          )}
          {confirmingDelete ? (
            <>
              <span className="me-auto vc-hint">Delete #{channel.name} and all its messages?</span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingDelete(false)}>Cancel</button>
              <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => run(() => deleteChannel(guild.id, channel.id))}>
                Delete
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
              <button type="submit" form="channel-form" className="btn btn-primary btn-sm vc-button" disabled={busy || !preview}>
                {editing ? 'Save' : 'Create channel'}
              </button>
            </>
          )}
        </>
      )}
    >
      <form id="channel-form" className="vc-form" onSubmit={save}>
        {!editing && (
          <fieldset className="channel-type-choice">
            <legend>Channel type</legend>
            <label className={type === 'text' ? 'selected' : ''}>
              <input type="radio" name="channel-type" value="text" checked={type === 'text'} onChange={() => setType('text')} />
              <FontAwesomeIcon icon={faHashtag} /> Text
            </label>
            <label className={type === 'voice' ? 'selected' : ''}>
              <input type="radio" name="channel-type" value="voice" checked={type === 'voice'} onChange={() => setType('voice')} />
              <FontAwesomeIcon icon={faVolumeHigh} /> Voice <span className="vc-hint">(coming later)</span>
            </label>
          </fieldset>
        )}

        <label htmlFor="channel-name">Channel name</label>
        <input
          id="channel-name"
          className="form-control"
          maxLength={100}
          placeholder="new-channel"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        {preview && preview !== name && <p className="vc-hint">Will be #{preview}</p>}

        {(editing ? channel.type === 'text' : type === 'text') && (
          <>
            <label htmlFor="channel-topic">Topic</label>
            <input
              id="channel-topic"
              className="form-control"
              maxLength={1024}
              placeholder="Let everyone know how to use this channel"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </>
        )}

        <label htmlFor="channel-category">Category</label>
        <select
          id="channel-category"
          className="form-select form-control"
          value={category ?? ''}
          onChange={(e) => setCategory(e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">No category</option>
          {guild.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </form>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
