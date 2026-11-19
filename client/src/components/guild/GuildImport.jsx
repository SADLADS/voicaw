import React, { useEffect, useMemo, useRef, useState } from 'react';
import { addGuildEmoji, createChannel, fetchGuildEmojis, fetchMembers } from '../../services/guildService';
import { deleteImport, listImports, setMapping } from '../../services/historyImport/importService';
import { archiveFile, emojiFile, readArchive, sendImport, startImport } from '../../services/historyImport/runImport';
import { errorMessage } from '../../utils/guildDisplay';
import { formatDate, formatDateTime } from '../../utils/dateFormat';
import { displayName, nameOf, useProfiles } from '../../utils/profiles';
import { ImportTag } from '../ImportedMessage';
import ConfirmDialog from './ConfirmDialog';
import { t } from '../../i18n';

// Guild Settings → Import (the owner or Administrator, while Settings → Admin allows it): old
// chat history from an exported archive into this guild's channels (docs/guilds.md, History
// imports). Choose the archive (read here, in the browser: services/historyImport/), say where
// each of its channels goes, who each author is and what its custom emoji become, pick the
// tag's word, then it's sent in batches. Past imports can be continued (choosing the same archive again), remapped or deleted.

const LABEL_MAX = 24;
const NEW = 'new';
const SKIP = '';

const pollText = ({ question, answer, votes, total }) => (answer
  ? t('guildAdmin.import.pollEnded', { question, answer, votes, total, count: total })
  : t('guildAdmin.import.pollEndedNoWinner', { question }));

export default function GuildImport({ guild }) {
  useProfiles();
  const [imports, setImports] = useState(null);
  const [members, setMembers] = useState([]);
  const [error, setError] = useState(null);
  // What's on screen: null (the list), { step: 'pick', resume? }, { step: 'map', read, view },
  // { step: 'run', read, view, targets }, { step: 'edit', view }.
  const [flow, setFlow] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const reload = () => listImports(guild.id).then(setImports).catch((err) => setError(errorMessage(err)));
  useEffect(() => {
    reload();
    fetchMembers(guild.id).then(setMembers).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id]);

  const back = () => {
    setFlow(null);
    reload();
  };

  if (flow?.step === 'pick') {
    return (
      <PickArchive
        resume={flow.resume}
        onCancel={back}
        onRead={async (read) => {
          if (flow.resume) {
            const targets = new Set(flow.resume.channels.filter((c) => c.channel_id != null).map((c) => c.source_id));
            setFlow({ step: 'run', read, view: flow.resume, targets });
            return;
          }
          const view = await startImport(guild.id, read, { label: null });
          setFlow({ step: 'map', read, view });
        }}
      />
    );
  }
  if (flow?.step === 'map') {
    return (
      <MapArchive
        guild={guild}
        members={members}
        read={flow.read}
        view={flow.view}
        onCancel={back}
        onStart={(view, targets) => setFlow({ step: 'run', read: flow.read, view, targets })}
      />
    );
  }
  if (flow?.step === 'run') {
    return <RunImport guild={guild} read={flow.read} view={flow.view} targets={flow.targets} onDone={back} />;
  }
  if (flow?.step === 'edit') {
    return <EditMapping guild={guild} members={members} view={flow.view} onDone={back} />;
  }

  return (
    <div className="vc-form guild-import">
      <p>{t('guildAdmin.import.intro')}</p>
      <p className="vc-hint">{t('guildAdmin.import.disclaimer')}</p>
      <div className="vc-form-row">
        <button type="button" className="btn btn-primary btn-sm vc-button" onClick={() => setFlow({ step: 'pick' })}>
          {t('guildAdmin.import.start')}
        </button>
      </div>
      {error && <p className="error-msg" role="alert">{error}</p>}
      <h6 className="guild-import-heading">{t('guildAdmin.import.past')}</h6>
      {imports == null ? null : imports.length === 0 ? (
        <p className="vc-hint">{t('guildAdmin.import.none')}</p>
      ) : (
        <ul className="guild-import-list">
          {imports.map((imp) => (
            <li key={imp.id} className="guild-import-item">
              <div className="guild-import-item-text">
                <strong>{imp.source_guild_name || t('guildAdmin.import.unnamed')}</strong>{' '}
                <ImportTag imported={{ label: imp.label, source_guild_name: imp.source_guild_name, importer_id: imp.importer_id, imported_at: imp.created_at, author: { mapped: false } }} />
                <span className="vc-hint">
                  {t('guildAdmin.import.pastLine', {
                    count: imp.message_count,
                    date: formatDateTime(imp.created_at * 1000),
                    name: imp.importer_id != null ? displayName(imp.importer_id) : t('chat.imported.someone'),
                  })}
                  {' · '}
                  {t(`guildAdmin.import.status.${imp.status}`)}
                </span>
              </div>
              <div className="guild-import-item-actions">
                {imp.status !== 'done' && (
                  <button type="button" className="btn btn-secondary btn-sm vc-button" onClick={() => setFlow({ step: 'pick', resume: imp })}>
                    {t('guildAdmin.import.continue')}
                  </button>
                )}
                <button type="button" className="btn btn-secondary btn-sm vc-button" onClick={() => setFlow({ step: 'edit', view: imp })}>
                  {t('guildAdmin.import.editMapping')}
                </button>
                <button type="button" className="btn btn-danger btn-sm vc-button" onClick={() => setDeleting(imp)}>
                  {t('common.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {deleting && (
        <ConfirmDialog
          title={t('guildAdmin.import.deleteTitle')}
          message={t('guildAdmin.import.deleteConfirm', { count: deleting.message_count })}
          confirmLabel={t('common.delete')}
          onConfirm={async () => {
            try {
              await deleteImport(guild.id, deleting.id);
            } catch (err) {
              setError(errorMessage(err));
            }
            reload();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

// Step 1: the archive.
function PickArchive({ resume, onRead, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [read, setRead] = useState(null);
  const [download, setDownload] = useState(true);
  const folderRef = useRef(null);

  async function choose(files) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    setRead(null);
    try {
      const result = await readArchive(files, { pollText });
      if (!result.channels.length) setError(t('guildAdmin.import.noChannels'));
      else setRead(result);
    } catch (err) {
      console.error('Reading the archive failed', err);
      setError(t('guildAdmin.import.unreadable'));
    } finally {
      setBusy(false);
    }
  }

  const messages = read ? read.channels.reduce((n, c) => n + c.messages.length, 0) : 0;
  return (
    <div className="vc-form guild-import">
      <h6 className="guild-import-heading">{resume ? t('guildAdmin.import.resumeTitle') : t('guildAdmin.import.pickTitle')}</h6>
      <p className="vc-hint">{t('guildAdmin.import.howTo')}</p>
      {resume && <p className="vc-hint">{t('guildAdmin.import.resumeHint')}</p>}
      <div className="vc-form-row">
        <label className="btn btn-secondary btn-sm vc-button guild-import-file">
          {t('guildAdmin.import.chooseFolder')}
          <input ref={folderRef} type="file" webkitdirectory="" directory="" multiple hidden disabled={busy} onChange={(e) => choose(e.target.files)} />
        </label>
        <label className="btn btn-secondary btn-sm vc-button guild-import-file">
          {t('guildAdmin.import.chooseFiles')}
          <input type="file" accept=".json,.zip,application/json,application/zip" multiple hidden disabled={busy} onChange={(e) => choose(e.target.files)} />
        </label>
      </div>
      {busy && <p className="vc-hint" role="status">{t('guildAdmin.import.reading')}</p>}
      {error && <p className="error-msg" role="alert">{error}</p>}
      {read && (
        <div className="guild-import-summary" role="status">
          <p>
            {t('guildAdmin.import.summary', {
              guild: read.guildName || t('guildAdmin.import.unnamed'),
              channels: read.channels.length,
              count: messages,
            })}
          </p>
          {read.files.total > 0 && (
            <p className={read.files.included < read.files.total ? 'guild-import-warning' : 'vc-hint'}>
              {t('guildAdmin.import.files', { included: read.files.included, count: read.files.total })}
              {read.files.downloadable > 0 && ` ${t('guildAdmin.import.filesLinked', { count: read.files.downloadable })}`}
              {read.files.expired > 0 && ` ${t('guildAdmin.import.filesExpired', { count: read.files.expired })}`}
              {read.files.included + read.files.downloadable < read.files.total && ` ${t('guildAdmin.import.filesMissing')}`}
              {read.files.tooBig > 0 && ` ${t('guildAdmin.import.filesTooBig', { count: read.files.tooBig })}`}
            </p>
          )}
          {read.download && (
            <label className="form-check guild-import-check">
              <input type="checkbox" className="form-check-input" checked={download} onChange={(e) => setDownload(e.target.checked)} />
              <span className="form-check-label">
                {t('guildAdmin.import.download')}
                <span className="vc-hint d-block">{t('guildAdmin.import.downloadHint')}</span>
              </span>
            </label>
          )}
          {read.unreadable.length > 0 && (
            <p className="vc-hint">{t('guildAdmin.import.skippedFiles', { count: read.unreadable.length })}</p>
          )}
        </div>
      )}
      <div className="vc-form-row">
        <button type="button" className="btn btn-secondary btn-sm vc-button" onClick={onCancel}>{t('common.cancel')}</button>
        <button
          type="button"
          className="btn btn-primary btn-sm vc-button"
          disabled={!read || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onRead({ ...read, download: read.download && download });
            } catch (err) {
              setError(errorMessage(err));
              setBusy(false);
            }
          }}
        >
          {resume ? t('guildAdmin.import.continue') : t('guildAdmin.import.next')}
        </button>
      </div>
    </div>
  );
}

const EMOJI_TEXT = 'text';
const EMOJI_ADD = 'add';
// Emoji names here are 2–32 characters; the archive's may be 1.
const emojiName = (name) => (name.length < 2 ? `${name}_` : name);
// Whether an archive emoji's picture can be had (in the archive, or downloaded when allowed).
const canAdd = (read, emoji) => Boolean(emoji && (emoji.imagePath || (read.download && emoji.imageUrl)));

// An archive emoji's picture: from the archive (an object URL, let go when it's not shown), or
// its link while downloading is allowed (that site then sees this browser, as the download
// would), else none.
function ArchiveEmojiImage({ read, emoji }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let url = null;
    let live = true;
    if (emoji.imagePath) {
      archiveFile(read, { path: emoji.imagePath }, { download: false }).then((blob) => {
        if (!live || !blob) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      }).catch(() => {});
    } else if (read.download && emoji.imageUrl) {
      setSrc(emoji.imageUrl);
    }
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [read, emoji]);
  return src
    ? <img className="guild-import-emoji" src={src} alt="" referrerPolicy="no-referrer" />
    : <span className="guild-import-emoji" aria-hidden="true" />;
}

// The archive's custom emoji: each becomes one of this guild's, is added to it from the
// archive's picture, or stays its name as text.
function ArchiveEmojis({ read, guildEmojis, choices, onChange, onAddAll }) {
  const rows = [...read.emojis.values()].sort((a, b) => b.uses - a.uses);
  const addable = rows.some((e) => choices[e.sourceId] === EMOJI_TEXT && canAdd(read, e));
  return (
    <>
      <h6 className="guild-import-heading">{t('guildAdmin.import.emojiTitle')}</h6>
      <p className="vc-hint">{t('guildAdmin.import.emojiHint')}</p>
      <ul className="guild-import-rows">
        {rows.map((e) => (
          <li key={e.sourceId} className="guild-import-row">
            <span className="guild-import-row-name">
              <span className="guild-import-emoji-name">
                <ArchiveEmojiImage read={read} emoji={e} />
                <strong>:{e.name}:</strong>
              </span>
              <span className="vc-hint">{t('guildAdmin.import.emojiLine', { count: e.uses })}</span>
            </span>
            <select
              className="form-select form-select-sm"
              aria-label={t('guildAdmin.import.emojiTarget', { name: e.name })}
              value={choices[e.sourceId] ?? EMOJI_TEXT}
              onChange={(event) => onChange(e.sourceId, event.target.value)}
            >
              <option value={EMOJI_TEXT}>{t('guildAdmin.import.emojiAsText', { name: e.name })}</option>
              {canAdd(read, e) && <option value={EMOJI_ADD}>{t('guildAdmin.import.emojiAdd')}</option>}
              {guildEmojis.map((g) => <option key={g.id} value={String(g.id)}>:{g.name}:</option>)}
            </select>
          </li>
        ))}
      </ul>
      {addable && (
        <div className="vc-form-row">
          <button type="button" className="btn btn-secondary btn-sm vc-button" onClick={onAddAll}>{t('guildAdmin.import.emojiAddAll')}</button>
        </div>
      )}
    </>
  );
}

const memberName = (m) => nameOf(m);
const sortedMembers = (members) => [...members].sort((a, b) => memberName(a).localeCompare(memberName(b)));

// A member picker for one archive author.
function AuthorSelect({ value, members, optedOut, onChange, label }) {
  return (
    <select className="form-select form-select-sm" aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{t('guildAdmin.import.keepName')}</option>
      {members.map((m) => (
        <option key={m.id} value={m.id} disabled={optedOut.has(m.id)}>
          {optedOut.has(m.id) ? t('guildAdmin.import.optedOut', { name: memberName(m) }) : memberName(m)}
        </option>
      ))}
    </select>
  );
}

// Step 2: where each channel goes, who each author is, the tag's word.
function MapArchive({ guild, members, read, view, onStart, onCancel }) {
  const [guildEmojis, setGuildEmojis] = useState([]);
  const [emojiChoices, setEmojiChoices] = useState({});
  useEffect(() => {
    fetchGuildEmojis(guild.id).then((list) => {
      setGuildEmojis(list);
      // An emoji of the same name if the guild has one, else its name as text.
      setEmojiChoices(Object.fromEntries([...read.emojis.values()].map((e) => {
        const same = list.find((g) => g.name.toLowerCase() === e.name.toLowerCase());
        return [e.sourceId, same ? String(same.id) : EMOJI_TEXT];
      })));
    }).catch(() => {});
  }, [guild.id, read.emojis]);
  const chatChannels = (guild.channels ?? []).filter((c) => c.type === 'text' || c.type === 'voice');
  const optedOut = useMemo(() => new Set(view.opted_out ?? []), [view.opted_out]);
  const people = useMemo(() => sortedMembers(members), [members]);
  const [label, setLabel] = useState('');
  const [channels, setChannels] = useState(() => Object.fromEntries(read.channels.map((c) => {
    const same = chatChannels.find((g) => g.name === c.name);
    return [c.sourceId, same ? String(same.id) : NEW];
  })));
  const [authors, setAuthors] = useState(() => Object.fromEntries(view.authors.map((a) => [a.id, view.suggested?.[a.id] ?? null])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const counts = new Map([...read.authors.values()].map((a) => [a.sourceId, a.messageCount]));
  const authorRows = [...view.authors].sort((a, b) => (counts.get(b.source_id) ?? 0) - (counts.get(a.source_id) ?? 0));

  async function start() {
    setBusy(true);
    setError(null);
    try {
      // Emoji to add from the archive's pictures, the same way (EmojiSettings' route). One that
      // fails is set to text and stops here, so the importer sees which (before any channel is made,
      // so pressing Import again makes none twice).
      const emojis = [];
      for (const e of read.emojis.values()) {
        const choice = emojiChoices[e.sourceId] ?? EMOJI_TEXT;
        let emojiId = choice === EMOJI_TEXT ? null : Number(choice);
        if (choice === EMOJI_ADD) {
          try {
            const file = await emojiFile(read, e);
            const added = await addGuildEmoji(guild.id, emojiName(e.name), file);
            emojiId = added.id;
            setGuildEmojis((list) => [...list, added]);
            setEmojiChoices((prev) => ({ ...prev, [e.sourceId]: String(added.id) }));
          } catch (err) {
            setEmojiChoices((prev) => ({ ...prev, [e.sourceId]: EMOJI_TEXT }));
            setError(t('guildAdmin.import.emojiAddFailed', { name: e.name, error: errorMessage(err) }));
            setBusy(false);
            return;
          }
        }
        emojis.push({ sourceId: e.sourceId, emojiId });
      }
      // New channels first (the usual way, so the usual checks), in a category of the
      // archive's category's name if the guild has one.
      const mapped = [];
      for (const c of read.channels) {
        const choice = channels[c.sourceId];
        if (choice === SKIP) continue;
        let channelId = Number(choice);
        if (choice === NEW) {
          const category = (guild.categories ?? []).find((k) => k.name.toLowerCase() === (c.category ?? '').toLowerCase());
          channelId = (await createChannel(guild.id, { name: c.name, type: 'text', categoryId: category?.id ?? null })).id;
        }
        mapped.push({ sourceId: c.sourceId, channelId });
      }
      const updated = await setMapping(guild.id, view.id, {
        label: label.trim() || null,
        authors: view.authors.map((a) => ({ id: a.id, userId: authors[a.id] ?? null })),
        channels: mapped,
        emojis,
      });
      onStart(updated, new Set(mapped.map((m) => m.sourceId)));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const going = read.channels.filter((c) => channels[c.sourceId] !== SKIP);
  return (
    <div className="vc-form guild-import">
      <h6 className="guild-import-heading">{t('guildAdmin.import.channelsTitle')}</h6>
      <ul className="guild-import-rows">
        {read.channels.map((c) => (
          <li key={c.sourceId} className="guild-import-row">
            <span className="guild-import-row-name">
              <strong>#{c.name}</strong>
              {c.thread && <span className="vc-hint"> {t('guildAdmin.import.thread', { channel: c.category ?? '' })}</span>}
              <span className="vc-hint">
                {t('guildAdmin.import.channelLine', {
                  count: c.messages.length,
                  from: c.first ? formatDate(c.first) : '',
                  to: c.last ? formatDate(c.last) : '',
                })}
              </span>
            </span>
            <select
              className="form-select form-select-sm"
              aria-label={t('guildAdmin.import.channelTarget', { name: c.name })}
              value={channels[c.sourceId]}
              onChange={(e) => setChannels((prev) => ({ ...prev, [c.sourceId]: e.target.value }))}
            >
              <option value={NEW}>{t('guildAdmin.import.newChannel', { name: c.name })}</option>
              {chatChannels.map((g) => <option key={g.id} value={String(g.id)}>#{g.name}</option>)}
              <option value={SKIP}>{t('guildAdmin.import.skip')}</option>
            </select>
          </li>
        ))}
      </ul>
      <p className="vc-hint">{t('guildAdmin.import.mergeHint')}</p>

      <h6 className="guild-import-heading">{t('guildAdmin.import.authorsTitle')}</h6>
      <p className="vc-hint">{t('guildAdmin.import.authorsHint')}</p>
      <ul className="guild-import-rows">
        {authorRows.map((a) => (
          <li key={a.id} className="guild-import-row">
            <span className="guild-import-row-name">
              <strong>{a.name}</strong>
              {a.is_bot ? <span className="app-tag">{t('chat.message.botTag')}</span> : null}
              <span className="vc-hint">{t('guildAdmin.import.authorLine', { count: counts.get(a.source_id) ?? 0 })}</span>
            </span>
            <AuthorSelect
              value={authors[a.id]}
              members={people}
              optedOut={optedOut}
              label={t('guildAdmin.import.authorTarget', { name: a.name })}
              onChange={(userId) => setAuthors((prev) => ({ ...prev, [a.id]: userId }))}
            />
          </li>
        ))}
      </ul>

      {read.emojis.size > 0 && (
        <ArchiveEmojis
          read={read}
          guildEmojis={guildEmojis}
          choices={emojiChoices}
          onChange={(sourceId, value) => setEmojiChoices((prev) => ({ ...prev, [sourceId]: value }))}
          onAddAll={() => setEmojiChoices((prev) => Object.fromEntries(Object.entries(prev).map(([id, value]) => [
            id, value === EMOJI_TEXT && canAdd(read, read.emojis.get(id)) ? EMOJI_ADD : value,
          ])))}
        />
      )}

      <h6 className="guild-import-heading">{t('guildAdmin.import.labelTitle')}</h6>
      <label className="guild-import-label">
        <span className="vc-hint">{t('guildAdmin.import.labelHint')}</span>
        <input
          className="form-control form-control-sm"
          maxLength={LABEL_MAX}
          placeholder={t('chat.imported.tag')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <p className="guild-import-preview">
        <strong>{read.authors.values().next().value?.name ?? '?'}</strong>{' '}
        <ImportTag imported={{ label: label.trim() || null, source_guild_name: read.guildName, importer_id: null, imported_at: Math.floor(Date.now() / 1000), author: { mapped: false } }} />
      </p>
      <p className="vc-hint">{t('guildAdmin.import.disclaimer')}</p>

      {error && <p className="error-msg" role="alert">{error}</p>}
      <div className="vc-form-row">
        <button type="button" className="btn btn-secondary btn-sm vc-button" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary btn-sm vc-button" onClick={start} disabled={busy || going.length === 0}>
          {t('guildAdmin.import.go', { count: going.reduce((n, c) => n + c.messages.length, 0) })}
        </button>
      </div>
    </div>
  );
}

// Step 3: sending it, with a Stop (it can be continued from Past imports).
function RunImport({ guild, read, view, targets, onDone }) {
  const [progress, setProgress] = useState({ messages: 0, files: 0, failedFiles: 0, totalMessages: 1, channel: null });
  const [state, setState] = useState('running'); // running | stopped | done | failed
  const [error, setError] = useState(null);
  const abort = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    sendImport(guild.id, view, read, { targets, signal: controller.signal, onProgress: setProgress })
      .then((final) => {
        setProgress(final);
        setState(controller.signal.aborted ? 'stopped' : 'done');
      })
      .catch((err) => {
        console.error('The import failed', err);
        setError(errorMessage(err));
        setState('failed');
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const percent = Math.min(100, Math.round((progress.messages / Math.max(progress.totalMessages, 1)) * 100));
  return (
    <div className="vc-form guild-import">
      <h6 className="guild-import-heading">{t(`guildAdmin.import.run.${state}`)}</h6>
      <div className="guild-import-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="guild-import-progress-bar" style={{ width: `${percent}%` }} />
      </div>
      <p className="vc-hint" role="status">
        {t('guildAdmin.import.run.messages', { done: progress.messages, count: progress.totalMessages })}
        {' · '}
        {t('guildAdmin.import.run.files', { count: progress.files })}
        {progress.failedFiles > 0 && ` · ${t('guildAdmin.import.run.failedFiles', { count: progress.failedFiles })}`}
        {state === 'running' && progress.channel && ` · #${progress.channel}`}
      </p>
      {state === 'running' && <p className="vc-hint">{t('guildAdmin.import.run.keepOpen')}</p>}
      {(state === 'stopped' || state === 'failed') && <p className="vc-hint">{t('guildAdmin.import.run.canContinue')}</p>}
      {error && <p className="error-msg" role="alert">{error}</p>}
      <div className="vc-form-row">
        {state === 'running'
          ? <button type="button" className="btn btn-secondary btn-sm vc-button" onClick={() => abort.current?.abort()}>{t('guildAdmin.import.run.stop')}</button>
          : <button type="button" className="btn btn-primary btn-sm vc-button" onClick={onDone}>{t('common.done')}</button>}
      </div>
    </div>
  );
}

// A past import's authors: who they are, and their names.
function EditMapping({ guild, members, view, onDone }) {
  const optedOut = useMemo(() => new Set(view.opted_out ?? []), [view.opted_out]);
  const people = useMemo(() => sortedMembers(members), [members]);
  const [label, setLabel] = useState(view.label ?? '');
  const [authors, setAuthors] = useState(() => Object.fromEntries(view.authors.map((a) => [a.id, { userId: a.user_id ?? null, name: a.name }])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const rows = [...view.authors].sort((a, b) => b.message_count - a.message_count);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await setMapping(guild.id, view.id, {
        label: label.trim() || null,
        authors: view.authors.map((a) => ({ id: a.id, userId: authors[a.id].userId, name: authors[a.id].name })),
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="vc-form guild-import">
      <h6 className="guild-import-heading">{t('guildAdmin.import.editTitle', { name: view.source_guild_name || t('guildAdmin.import.unnamed') })}</h6>
      <label className="guild-import-label">
        <span className="vc-hint">{t('guildAdmin.import.labelHint')}</span>
        <input className="form-control form-control-sm" maxLength={LABEL_MAX} placeholder={t('chat.imported.tag')} value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <p className="vc-hint">{t('guildAdmin.import.renameHint')}</p>
      <ul className="guild-import-rows">
        {rows.map((a) => (
          <li key={a.id} className="guild-import-row">
            <span className="guild-import-row-name">
              <input
                className="form-control form-control-sm"
                aria-label={t('guildAdmin.import.authorName')}
                maxLength={80}
                value={authors[a.id].name}
                onChange={(e) => setAuthors((prev) => ({ ...prev, [a.id]: { ...prev[a.id], name: e.target.value } }))}
              />
              <span className="vc-hint">{t('guildAdmin.import.authorLine', { count: a.message_count })}</span>
            </span>
            <AuthorSelect
              value={authors[a.id].userId}
              members={people}
              optedOut={optedOut}
              label={t('guildAdmin.import.authorTarget', { name: a.name })}
              onChange={(userId) => setAuthors((prev) => ({ ...prev, [a.id]: { ...prev[a.id], userId } }))}
            />
          </li>
        ))}
      </ul>
      {error && <p className="error-msg" role="alert">{error}</p>}
      <div className="vc-form-row">
        <button type="button" className="btn btn-secondary btn-sm vc-button" onClick={onDone} disabled={busy}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary btn-sm vc-button" onClick={save} disabled={busy || rows.some((a) => !authors[a.id].name.trim())}>
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}
