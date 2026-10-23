import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EditorView } from 'prosemirror-view';
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, deleteTable, isInTable } from 'prosemirror-tables';
import { Icon } from '../Icon';
import {
  faArrowRotateLeft, faArrowRotateRight, faBold, faCode, faEyeSlash, faImage, faItalic, faLink,
  faListCheck, faListOl, faListUl, faMinus, faQuoteLeft, faStrikethrough, faTable, faUnderline,
} from '@fortawesome/free-solid-svg-icons';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-tables/style/tables.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import DocumentCover from './DocumentCover';
import ConfirmDialog from '../guild/ConfirmDialog';
import Avatar from '../Avatar';
import { markdownToDoc, docToMarkdown } from '../../documents/documentMarkdown';
import { schema } from '../../documents/documentSchema';
import {
  blockStyle, bulletList, createEditorState, inQuote, insertImage, insertRule, insertTable, linkActive,
  listKind, makeCodeBlock, makeHeading, makeParagraph, markActive, nodeViews, orderedList, redo, setLink,
  toggleBold, toggleChecklist, toggleCode, toggleItalic, toggleQuote, toggleSpoiler, toggleStrike,
  toggleUnderline, undo,
} from '../../documents/editorSetup';
import { startDocumentCollab } from '../../documents/documentCollab';
import { colourOf } from '../../documents/collabCursors';
import { uploadAttachment } from '../../services/attachmentUpload';
import { seedAttachmentCache } from '../../services/attachmentCache';
import { readMediaDimensions } from '../../utils/mediaDimensions';
import { createDocument } from '../../services/guildService';
import { fetchUsersList } from '../../services/dmService';
import { errorMessage } from '../../utils/guildDisplay';
import { displayName, getProfile, mergeProfiles, useProfiles } from '../../utils/profiles';
import { t } from '../../i18n';

const MAX_TITLE = 200;
const MAX_CONTENT = 100000;
// A title being typed in a live document goes to the others after this pause.
const TITLE_DELAY_MS = 600;

const BLOCK_STYLES = [
  ['paragraph', () => t('documents.editor.styles.paragraph')],
  ['h1', () => t('documents.editor.styles.heading', { level: 1 })],
  ['h2', () => t('documents.editor.styles.heading', { level: 2 })],
  ['h3', () => t('documents.editor.styles.heading', { level: 3 })],
  ['h4', () => t('documents.editor.styles.heading', { level: 4 })],
  ['code', () => t('documents.editor.styles.code')],
];

const LIVE_STATUS = {
  connecting: () => t('documents.editor.live.connecting'),
  saving: () => t('documents.editor.saving'),
  saved: () => t('documents.editor.live.saved'),
  offline: () => t('documents.editor.live.offline'),
};

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const shortcut = (keys) => keys.replace('Mod', isMac ? '⌘' : 'Ctrl');
const cleanTitle = (title) => title.replace(/\s+/g, ' ').trim();

// An image file, uploaded encrypted like a message attachment; its URL (with the key) is what
// the document stores. Shown at once from the local copy.
async function uploadImage(file) {
  const objectUrl = URL.createObjectURL(file);
  const dimensions = await readMediaDimensions(file, objectUrl).catch(() => null);
  const url = await uploadAttachment(file, null, dimensions);
  seedAttachmentCache(url, objectUrl);
  return url;
}

const imageFiles = (list) => Array.from(list ?? []).filter((f) => f.type.startsWith('image/'));
// While dragging, only the types of the files can be read.
const dragHasImage = (e) => Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === 'file' && i.type.startsWith('image/'));

function ToolButton({ icon, label, keys, active = false, disabled = false, onRun, children }) {
  return (
    <button
      type="button"
      className={`doc-tool${active ? ' active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={keys ? t('documents.editor.withShortcut', { label, keys: shortcut(keys) }) : label}
      disabled={disabled}
      // Keep the editor's selection: run without taking focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
    >
      {icon ? <Icon icon={icon} /> : children}
    </button>
  );
}

// Who else is editing: their pictures, ringed in their cursor's colour.
function Editors({ editors, userId }) {
  useProfiles();
  const people = [...new Set(editors.map((e) => e.userId))].filter((id) => id !== userId);
  if (!people.length) return null;
  return (
    <span className="doc-editors" role="group" aria-label={t('documents.editor.live.editors', { count: people.length })}>
      {people.map((id) => {
        const name = displayName(id, t('documents.deletedUser'));
        return (
          <span key={id} className={`doc-editor-person collab-colour-${colourOf(id)}`} title={t('documents.editor.live.isEditing', { name })}>
            <Avatar userId={id} className="doc-editor-person-avatar" />
          </span>
        );
      })}
    </span>
  );
}

// Writing or editing a document, like a word processor: title, optional cover image (picked, or
// an image dropped on its button), and
// the text with a toolbar (styles, bold/italic/underline/strikethrough, lists and checklists,
// quotes, code, links, images, tables, rules). It saves markdown. `document` is the one being
// edited (null: a new one in `channel`, published with Publish: `onSaved`, or `onCancel`). A
// document is edited live (documents/documentCollab.js): everyone editing it sees the others'
// changes and cursors as they're made, and the server saves as they go; Done (`onDone(document)`,
// with what it is now) closes the editor. `canManage`: may let others edit it (its author, or
// Manage Messages). `userId`: who is editing here.
export default function DocumentEditor({ channel, document, userId, canManage = false, onSaved, onCancel, onDone }) {
  const live = Boolean(document);
  const mountRef = useRef(null);
  const viewRef = useRef(null);
  const fileRef = useRef(null);
  const coverFileRef = useRef(null);
  const [, setTick] = useState(0);
  const [title, setTitle] = useState(document?.title ?? '');
  const [cover, setCover] = useState(document?.cover ?? null);
  // An image is being dragged over "Add a cover image" (dropping it there makes it the cover).
  const [coverDragOver, setCoverDragOver] = useState(false);
  const initial = useRef({ title: document?.title ?? '', cover: document?.cover ?? null, content: document?.content ?? '' });
  const [uploading, setUploading] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // The link being typed (null: the link box is closed).
  const [linkDraft, setLinkDraft] = useState(null);
  const [openEditing, setOpenEditing] = useState(Boolean(document?.open_editing));
  // Live editing: the controller, how saving is going, who else is here, a message about it.
  const collabRef = useRef(null);
  const [liveStatus, setLiveStatus] = useState('connecting');
  const [editors, setEditors] = useState([]);
  const [notice, setNotice] = useState(null);
  const [ended, setEnded] = useState(false);
  const [finishing, setFinishing] = useState(false);
  // A title typed but not yet sent (the others' titles don't replace it meanwhile).
  const titleTimer = useRef(null);
  const pendingTitle = useRef(null);

  const addImages = useCallback(async (files) => {
    const images = imageFiles(files);
    if (!images.length) return;
    setUploading((n) => n + images.length);
    for (const file of images) {
      try {
        const url = await uploadImage(file);
        if (viewRef.current) insertImage(viewRef.current, url, file.name.replace(/\.[^.]+$/, ''));
      } catch (err) {
        setError(t('documents.editor.uploadFailed', { name: file.name, error: errorMessage(err) }));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }, []);
  const addImagesRef = useRef(addImages);
  addImagesRef.current = addImages;

  // The ProseMirror view, made once; the toolbar redraws on every change. A live document can
  // be typed in once it has joined the session.
  const editableRef = useRef(!live);
  useEffect(() => {
    const view = new EditorView(mountRef.current, {
      state: createEditorState(markdownToDoc(initial.current.content)),
      nodeViews,
      editable: () => editableRef.current,
      attributes: { class: 'doc-editor-text document-body', 'aria-label': t('documents.editor.document') },
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        collabRef.current?.changed(tr);
        setTick((n) => n + 1);
      },
      handlePaste(_view, event) {
        const files = imageFiles(event.clipboardData?.files);
        if (!files.length) return false;
        addImagesRef.current(files);
        return true;
      },
      handleDrop(_view, event) {
        const files = imageFiles(event.dataTransfer?.files);
        if (!files.length) return false;
        event.preventDefault();
        addImagesRef.current(files);
        return true;
      },
    });
    viewRef.current = view;
    if (live) {
      let focused = false;
      const setEditable = (on) => {
        if (editableRef.current === on) return;
        editableRef.current = on;
        view.setProps({});
        // The first time it can be typed in, the cursor goes there.
        if (on && !focused) {
          focused = true;
          view.focus();
        }
      };
      collabRef.current = startDocumentCollab({
        view,
        document,
        makeState: (doc, plugins) => createEditorState(doc, { extraPlugins: plugins }),
        onStatus: (status) => {
          setLiveStatus(status);
          setEditable(status !== 'connecting');
          setTick((n) => n + 1);
        },
        onEditors: setEditors,
        onDetails: (details) => {
          if (pendingTitle.current == null) setTitle(details.title);
          setCover(details.cover);
          setOpenEditing(Boolean(details.open_editing));
        },
        onNotice: (kind, message) => setNotice(kind === 'lost'
          ? t('documents.editor.live.lost')
          : t('documents.editor.live.refused', { error: message || t('documents.editor.live.refusedUnknown') })),
        onEnded: (reason) => {
          setEditable(false);
          setEnded(true);
          setNotice(reason === 'deleted' ? t('documents.editor.live.deleted') : t('documents.editor.live.forbidden'));
        },
      });
    }
    return () => {
      collabRef.current?.stop();
      collabRef.current = null;
      clearTimeout(titleTimer.current);
      view.destroy();
      viewRef.current = null;
    };
    // Made once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The others' carets carry their names: someone not known here yet (an account made since
  // the app loaded the directory) is looked up, and the carets redrawn as names change.
  const profilesVersion = useProfiles();
  const lookedUp = useRef(new Set());
  useEffect(() => {
    const unknown = editors.map((e) => e.userId).filter((id) => !getProfile(id) && !lookedUp.current.has(id));
    if (!unknown.length) return;
    unknown.forEach((id) => lookedUp.current.add(id));
    fetchUsersList().then(mergeProfiles).catch((err) => console.warn('Failed to load profiles', err));
  }, [editors]);
  useEffect(() => {
    collabRef.current?.refreshCursors();
  }, [profilesVersion]);

  // Live: the title goes to the others once typing pauses (an empty one isn't sent).
  const sendTitle = useCallback(() => {
    clearTimeout(titleTimer.current);
    const next = pendingTitle.current;
    pendingTitle.current = null;
    if (next == null || !collabRef.current) return Promise.resolve();
    return collabRef.current.details({ title: next }).catch((err) => setError(errorMessage(err)));
  }, []);
  const changeTitle = (value) => {
    setTitle(value);
    if (!live) return;
    const clean = cleanTitle(value);
    pendingTitle.current = clean || null;
    clearTimeout(titleTimer.current);
    if (clean) titleTimer.current = setTimeout(sendTitle, TITLE_DELAY_MS);
  };
  const changeCover = (next) => {
    setCover(next);
    if (live) collabRef.current?.details({ cover: next }).catch((err) => setError(errorMessage(err)));
  };
  const changeOpenEditing = (on) => {
    setOpenEditing(on);
    if (live) collabRef.current?.details({ open_editing: on }).catch((err) => setError(errorMessage(err)));
  };

  const view = viewRef.current;
  const state = view?.state;
  const run = (command) => () => {
    if (!view) return;
    command(view.state, view.dispatch, view);
    view.focus();
  };
  const content = () => (view ? docToMarkdown(view.state.doc) : initial.current.content);
  const dirty = () => (live
    ? Boolean(collabRef.current?.hasUnsaved() || pendingTitle.current)
    : title.trim() !== initial.current.title || cover !== initial.current.cover || content() !== initial.current.content);

  // Leaving the page with unsaved changes asks first.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const warn = (e) => {
      if (!dirtyRef.current()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // A new document: published.
  async function publish() {
    const cleanedTitle = cleanTitle(title);
    const text = content();
    if (!cleanedTitle) {
      setError(t('documents.editor.needTitle'));
      return;
    }
    if (text.length > MAX_CONTENT) {
      setError(t('documents.editor.tooLong', { max: MAX_CONTENT.toLocaleString(), length: text.length.toLocaleString() }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await createDocument(channel.id, { title: cleanedTitle, cover, content: text, open_editing: openEditing });
      initial.current = { title: saved.title, cover: saved.cover, content: saved.content };
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // Live: what's typed reaches the server, then the editor closes with the document as it is.
  async function finish() {
    setFinishing(true);
    await sendTitle();
    await collabRef.current?.finish();
    onDone({
      ...document,
      title: cleanTitle(title) || document.title,
      cover,
      open_editing: openEditing ? 1 : 0,
      content: content(),
    });
  }
  const actRef = useRef(null);
  actRef.current = live ? sendTitle : publish;

  // Ctrl/⌘+S publishes a new document (a live one saves itself: only a title waiting to be sent
  // goes now).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        actRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function cancel() {
    if (dirty()) setConfirmDiscard(true);
    else onCancel();
  }

  async function pickCover(file) {
    if (!file?.type.startsWith('image/')) return;
    setUploading((n) => n + 1);
    try {
      changeCover(await uploadImage(file));
    } catch (err) {
      setError(t('documents.editor.coverUploadFailed', { error: errorMessage(err) }));
    } finally {
      setUploading((n) => n - 1);
    }
  }

  function applyLink(e) {
    e.preventDefault();
    const href = linkDraft.trim();
    setLinkDraft(null);
    if (!href) return;
    run(setLink(/^[a-z][\w+.-]*:/i.test(href) ? href : `https://${href}`))();
  }

  const style = state ? blockStyle(state) : 'paragraph';
  const list = state ? listKind(state) : null;
  const inTable = state ? isInTable(state) : false;
  const can = (command) => Boolean(state && command(state));
  const locked = live && (ended || liveStatus === 'connecting');

  const openEditingBox = canManage && (
    <label className="doc-open-editing" title={t('documents.editor.live.othersCanEditHint')}>
      <input type="checkbox" checked={openEditing} disabled={ended} onChange={(e) => changeOpenEditing(e.target.checked)} />
      {' '}{t('documents.editor.live.othersCanEdit')}
    </label>
  );

  return (
    <div className="doc-editor">
      {live ? (
        <div className="doc-editor-bar">
          <Editors editors={editors} userId={userId} />
          <span className="doc-editor-status" role="status">
            {uploading > 0 ? t('documents.editor.uploadingImage') : LIVE_STATUS[liveStatus]?.()}
          </span>
          {openEditingBox}
          <button type="button" className="btn btn-primary btn-sm vc-button" onClick={finish} disabled={finishing || uploading > 0}>
            {t('documents.editor.live.done')}
          </button>
        </div>
      ) : (
        <div className="doc-editor-bar">
          <button type="button" className="btn btn-secondary btn-sm" onClick={cancel} disabled={saving}>{t('common.cancel')}</button>
          <span className="doc-editor-status" role="status">
            {uploading > 0 ? t('documents.editor.uploadingImage') : saving ? t('documents.editor.saving') : ''}
          </span>
          {openEditingBox}
          <button type="button" className="btn btn-primary btn-sm vc-button" onClick={publish} disabled={saving || uploading > 0}>
            {t('documents.editor.publish')}
          </button>
        </div>
      )}

      <div className="doc-toolbar" role="toolbar" aria-label={t('documents.editor.formatting')}>
        <select
          className="doc-style-select form-select form-select-sm"
          aria-label={t('documents.editor.textStyle')}
          value={style ?? ''}
          disabled={locked}
          onChange={(e) => {
            const choice = e.target.value;
            run(choice === 'paragraph' ? makeParagraph : choice === 'code' ? makeCodeBlock : makeHeading(Number(choice.slice(1))))();
          }}
        >
          {style == null && <option value="">{t('documents.editor.styles.mixed')}</option>}
          {style && /^h[56]$/.test(style) && <option value={style}>{t('documents.editor.styles.heading', { level: style.slice(1) })}</option>}
          {BLOCK_STYLES.map(([value, label]) => <option key={value} value={value}>{label()}</option>)}
        </select>
        <span className="doc-tool-group">
          <ToolButton icon={faBold} label={t('documents.editor.tools.bold')} keys="Mod+B" active={state && markActive(state, schema.marks.strong)} disabled={locked} onRun={run(toggleBold)} />
          <ToolButton icon={faItalic} label={t('documents.editor.tools.italic')} keys="Mod+I" active={state && markActive(state, schema.marks.em)} disabled={locked} onRun={run(toggleItalic)} />
          <ToolButton icon={faUnderline} label={t('documents.editor.tools.underline')} keys="Mod+U" active={state && markActive(state, schema.marks.underline)} disabled={locked} onRun={run(toggleUnderline)} />
          <ToolButton icon={faStrikethrough} label={t('documents.editor.tools.strikethrough')} keys="Mod+Shift+X" active={state && markActive(state, schema.marks.strike)} disabled={locked} onRun={run(toggleStrike)} />
          <ToolButton icon={faCode} label={t('documents.editor.tools.inlineCode')} keys="Mod+E" active={state && markActive(state, schema.marks.code)} disabled={locked} onRun={run(toggleCode)} />
          <ToolButton icon={faEyeSlash} label={t('documents.editor.tools.spoiler')} active={state && markActive(state, schema.marks.spoiler)} disabled={locked} onRun={run(toggleSpoiler)} />
          <ToolButton
            icon={faLink}
            label={state && linkActive(state) ? t('documents.editor.tools.removeLink') : t('documents.editor.tools.link')}
            active={state && linkActive(state)}
            disabled={locked}
            onRun={() => (state && linkActive(state) ? run(setLink(null))() : setLinkDraft(''))}
          />
        </span>
        <span className="doc-tool-group">
          <ToolButton icon={faListUl} label={t('documents.editor.tools.bulletedList')} keys="Mod+Shift+8" active={list === 'bullet'} disabled={locked || (!can(bulletList) && list !== 'bullet')} onRun={run(bulletList)} />
          <ToolButton icon={faListOl} label={t('documents.editor.tools.numberedList')} keys="Mod+Shift+7" active={list === 'ordered'} disabled={locked || (!can(orderedList) && list !== 'ordered')} onRun={run(orderedList)} />
          <ToolButton icon={faListCheck} label={t('documents.editor.tools.checklist')} keys="Mod+Shift+9" active={list === 'check'} disabled={locked} onRun={run(toggleChecklist)} />
          <ToolButton icon={faQuoteLeft} label={t('documents.editor.tools.quote')} active={state && inQuote(state)} disabled={locked} onRun={run(toggleQuote)} />
        </span>
        <span className="doc-tool-group">
          <ToolButton icon={faImage} label={t('documents.editor.tools.insertImage')} disabled={locked} onRun={() => fileRef.current?.click()} />
          <ToolButton icon={faTable} label={t('documents.editor.tools.insertTable')} disabled={locked || inTable} onRun={run(insertTable(3, 3))} />
          <ToolButton icon={faMinus} label={t('documents.editor.tools.horizontalLine')} disabled={locked} onRun={run(insertRule)} />
        </span>
        <span className="doc-tool-group">
          <ToolButton icon={faArrowRotateLeft} label={t('documents.editor.tools.undo')} keys="Mod+Z" disabled={locked || !can(undo)} onRun={run(undo)} />
          <ToolButton icon={faArrowRotateRight} label={t('documents.editor.tools.redo')} keys="Mod+Y" disabled={locked || !can(redo)} onRun={run(redo)} />
        </span>
        {inTable && !locked && (
          <span className="doc-tool-group doc-table-tools" aria-label={t('documents.editor.table.label')}>
            <ToolButton label={t('documents.editor.table.addRow')} onRun={run(addRowAfter)}>{t('documents.editor.table.addRowShort')}</ToolButton>
            <ToolButton label={t('documents.editor.table.addColumn')} onRun={run(addColumnAfter)}>{t('documents.editor.table.addColumnShort')}</ToolButton>
            <ToolButton label={t('documents.editor.table.deleteRow')} disabled={!can(deleteRow)} onRun={run(deleteRow)}>{t('documents.editor.table.deleteRowShort')}</ToolButton>
            <ToolButton label={t('documents.editor.table.deleteColumn')} disabled={!can(deleteColumn)} onRun={run(deleteColumn)}>{t('documents.editor.table.deleteColumnShort')}</ToolButton>
            <ToolButton label={t('documents.editor.table.deleteTable')} onRun={run(deleteTable)}>{t('documents.editor.table.deleteTable')}</ToolButton>
          </span>
        )}
        {linkDraft != null && (
          <form className="doc-link-form" onSubmit={applyLink}>
            <input
              className="form-control form-control-sm"
              aria-label={t('documents.editor.link.address')}
              placeholder={t('documents.editor.link.placeholder')}
              value={linkDraft}
              autoFocus
              onChange={(e) => setLinkDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setLinkDraft(null); view?.focus(); } }}
            />
            <button type="submit" className="btn btn-primary btn-sm vc-button">{t('documents.editor.link.add')}</button>
          </form>
        )}
        <input ref={fileRef} type="file" accept="image/*" multiple hidden aria-label={t('documents.editor.imageFile')} onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />
        <input ref={coverFileRef} type="file" accept="image/*" hidden aria-label={t('documents.editor.coverImageFile')} onChange={(e) => { pickCover(e.target.files?.[0]); e.target.value = ''; }} />
      </div>

      {notice && (
        <div className="doc-conflict" role="alert">
          <span>{notice}</span>
          {!ended && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setNotice(null)}>{t('documents.editor.live.dismiss')}</button>}
        </div>
      )}
      {error && <p className="error-msg doc-editor-error" role="alert">{error}</p>}

      <div className="doc-editor-scroll">
        <div className="doc-editor-page">
          {cover ? (
            <div className="doc-editor-cover">
              <DocumentCover cover={cover} />
              <div className="doc-editor-cover-actions">
                <button type="button" className="btn btn-secondary btn-sm" disabled={locked} onClick={() => coverFileRef.current?.click()}>{t('documents.editor.changeCover')}</button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={locked} onClick={() => changeCover(null)}>{t('documents.editor.removeCover')}</button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={`doc-add-cover${coverDragOver ? ' drag-over' : ''}`}
              disabled={locked}
              onClick={() => coverFileRef.current?.click()}
              onDragOver={(e) => {
                if (!dragHasImage(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                setCoverDragOver(true);
              }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setCoverDragOver(false); }}
              onDrop={(e) => {
                setCoverDragOver(false);
                const [file] = imageFiles(e.dataTransfer.files);
                if (!file) return;
                e.preventDefault();
                pickCover(file);
              }}
            >
              <Icon icon={faImage} /> {t('documents.editor.addCover')}
            </button>
          )}
          <textarea
            className="doc-editor-title"
            aria-label={t('documents.editor.title')}
            placeholder={t('documents.editor.untitled')}
            rows={1}
            maxLength={MAX_TITLE}
            value={title}
            readOnly={locked}
            autoFocus={!document}
            onChange={(e) => changeTitle(e.target.value.replace(/\n/g, ' '))}
            onBlur={live ? sendTitle : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                view?.focus();
              }
            }}
          />
          <div ref={mountRef} className="doc-editor-mount" />
        </div>
      </div>

      {confirmDiscard && (
        <ConfirmDialog
          title={t('documents.editor.discard.title')}
          message={t('documents.editor.discard.new')}
          confirmLabel={t('documents.editor.discard.confirm')}
          focusConfirm
          onConfirm={async () => onCancel()}
          onClose={() => setConfirmDiscard(false)}
        />
      )}
    </div>
  );
}
