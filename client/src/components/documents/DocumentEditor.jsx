import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EditorView } from 'prosemirror-view';
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, deleteTable, isInTable } from 'prosemirror-tables';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowRotateLeft, faArrowRotateRight, faBold, faCode, faEyeSlash, faImage, faItalic, faLink,
  faListCheck, faListOl, faListUl, faMinus, faQuoteLeft, faStrikethrough, faTable, faUnderline,
} from '@fortawesome/free-solid-svg-icons';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-tables/style/tables.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import DocumentCover from './DocumentCover';
import ConfirmDialog from '../guild/ConfirmDialog';
import { markdownToDoc, docToMarkdown } from '../../documents/documentMarkdown';
import { schema } from '../../documents/documentSchema';
import {
  blockStyle, bulletList, createEditorState, inQuote, insertImage, insertRule, insertTable, linkActive,
  listKind, makeCodeBlock, makeHeading, makeParagraph, markActive, nodeViews, orderedList, redo, setLink,
  toggleBold, toggleChecklist, toggleCode, toggleItalic, toggleQuote, toggleSpoiler, toggleStrike,
  toggleUnderline, undo,
} from '../../documents/editorSetup';
import { uploadAttachment } from '../../services/attachmentUpload';
import { seedAttachmentCache } from '../../services/attachmentCache';
import { readMediaDimensions } from '../../utils/mediaDimensions';
import { createDocument, saveDocument } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { t } from '../../i18n';

const MAX_TITLE = 200;
const MAX_CONTENT = 100000;

const BLOCK_STYLES = [
  ['paragraph', () => t('documents.editor.styles.paragraph')],
  ['h1', () => t('documents.editor.styles.heading', { level: 1 })],
  ['h2', () => t('documents.editor.styles.heading', { level: 2 })],
  ['h3', () => t('documents.editor.styles.heading', { level: 3 })],
  ['h4', () => t('documents.editor.styles.heading', { level: 4 })],
  ['code', () => t('documents.editor.styles.code')],
];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const shortcut = (keys) => keys.replace('Mod', isMac ? '⌘' : 'Ctrl');

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
      {icon ? <FontAwesomeIcon icon={icon} /> : children}
    </button>
  );
}

// Writing or editing a document, like a word processor: title, optional cover image (picked, or
// an image dropped on its button), and
// the text with a toolbar (styles, bold/italic/underline/strikethrough, lists and checklists,
// quotes, code, links, images, tables, rules). It saves markdown. `document` is the one being
// edited (null: a new one in `channel`). Saving refuses to overwrite someone else's newer
// save: you choose to keep yours (save over it) or load theirs.
export default function DocumentEditor({ channel, document, onSaved, onCancel }) {
  const mountRef = useRef(null);
  const viewRef = useRef(null);
  const fileRef = useRef(null);
  const coverFileRef = useRef(null);
  const [, setTick] = useState(0);
  const [title, setTitle] = useState(document?.title ?? '');
  const [cover, setCover] = useState(document?.cover ?? null);
  // An image is being dragged over "Add a cover image" (dropping it there makes it the cover).
  const [coverDragOver, setCoverDragOver] = useState(false);
  // The version this edit is based on (a save sends it; the server refuses a stale one).
  const [baseVersion, setBaseVersion] = useState(document?.version ?? null);
  const initial = useRef({ title: document?.title ?? '', cover: document?.cover ?? null, content: document?.content ?? '' });
  const [uploading, setUploading] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // Someone else's newer save: { document }.
  const [conflict, setConflict] = useState(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // The link being typed (null: the link box is closed).
  const [linkDraft, setLinkDraft] = useState(null);

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

  // The ProseMirror view, made once; the toolbar redraws on every change.
  useEffect(() => {
    const view = new EditorView(mountRef.current, {
      state: createEditorState(markdownToDoc(initial.current.content)),
      nodeViews,
      attributes: { class: 'doc-editor-text document-body', 'aria-label': t('documents.editor.document') },
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
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
    if (document) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Made once; a document loaded later (their version) goes in with loadContent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadContent = (content) => {
    const view = viewRef.current;
    view.updateState(createEditorState(markdownToDoc(content)));
    setTick((n) => n + 1);
  };

  const view = viewRef.current;
  const state = view?.state;
  const run = (command) => () => {
    if (!view) return;
    command(view.state, view.dispatch, view);
    view.focus();
  };
  const content = () => (view ? docToMarkdown(view.state.doc) : initial.current.content);
  const dirty = () => title.trim() !== initial.current.title || cover !== initial.current.cover
    || content() !== initial.current.content;

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

  async function save(overVersion = baseVersion) {
    const cleanTitle = title.replace(/\s+/g, ' ').trim();
    const text = content();
    if (!cleanTitle) {
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
      const saved = document
        ? await saveDocument(document.id, { version: overVersion, title: cleanTitle, cover, content: text })
        : await createDocument(channel.id, { title: cleanTitle, cover, content: text });
      initial.current = { title: saved.title, cover: saved.cover, content: saved.content };
      setConflict(null);
      onSaved(saved);
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.document) setConflict({ document: err.response.data.document });
      else setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  const saveRef = useRef(save);
  saveRef.current = save;

  // Ctrl/⌘+S saves.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function loadTheirs() {
    const theirs = conflict.document;
    initial.current = { title: theirs.title, cover: theirs.cover, content: theirs.content };
    setTitle(theirs.title);
    setCover(theirs.cover);
    setBaseVersion(theirs.version);
    loadContent(theirs.content);
    setConflict(null);
  }

  function cancel() {
    if (dirty()) setConfirmDiscard(true);
    else onCancel();
  }

  async function pickCover(file) {
    if (!file?.type.startsWith('image/')) return;
    setUploading((n) => n + 1);
    try {
      setCover(await uploadImage(file));
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

  return (
    <div className="doc-editor">
      <div className="doc-editor-bar">
        <button type="button" className="btn btn-secondary btn-sm" onClick={cancel} disabled={saving}>{t('common.cancel')}</button>
        <span className="doc-editor-status" role="status">
          {uploading > 0 ? t('documents.editor.uploadingImage') : saving ? t('documents.editor.saving') : ''}
        </span>
        <button type="button" className="btn btn-primary btn-sm vc-button" onClick={() => save()} disabled={saving || uploading > 0}>
          {document ? t('common.save') : t('documents.editor.publish')}
        </button>
      </div>

      <div className="doc-toolbar" role="toolbar" aria-label={t('documents.editor.formatting')}>
        <select
          className="doc-style-select form-select form-select-sm"
          aria-label={t('documents.editor.textStyle')}
          value={style ?? ''}
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
          <ToolButton icon={faBold} label={t('documents.editor.tools.bold')} keys="Mod+B" active={state && markActive(state, schema.marks.strong)} onRun={run(toggleBold)} />
          <ToolButton icon={faItalic} label={t('documents.editor.tools.italic')} keys="Mod+I" active={state && markActive(state, schema.marks.em)} onRun={run(toggleItalic)} />
          <ToolButton icon={faUnderline} label={t('documents.editor.tools.underline')} keys="Mod+U" active={state && markActive(state, schema.marks.underline)} onRun={run(toggleUnderline)} />
          <ToolButton icon={faStrikethrough} label={t('documents.editor.tools.strikethrough')} keys="Mod+Shift+X" active={state && markActive(state, schema.marks.strike)} onRun={run(toggleStrike)} />
          <ToolButton icon={faCode} label={t('documents.editor.tools.inlineCode')} keys="Mod+E" active={state && markActive(state, schema.marks.code)} onRun={run(toggleCode)} />
          <ToolButton icon={faEyeSlash} label={t('documents.editor.tools.spoiler')} active={state && markActive(state, schema.marks.spoiler)} onRun={run(toggleSpoiler)} />
          <ToolButton
            icon={faLink}
            label={state && linkActive(state) ? t('documents.editor.tools.removeLink') : t('documents.editor.tools.link')}
            active={state && linkActive(state)}
            onRun={() => (state && linkActive(state) ? run(setLink(null))() : setLinkDraft(''))}
          />
        </span>
        <span className="doc-tool-group">
          <ToolButton icon={faListUl} label={t('documents.editor.tools.bulletedList')} keys="Mod+Shift+8" active={list === 'bullet'} disabled={!can(bulletList) && list !== 'bullet'} onRun={run(bulletList)} />
          <ToolButton icon={faListOl} label={t('documents.editor.tools.numberedList')} keys="Mod+Shift+7" active={list === 'ordered'} disabled={!can(orderedList) && list !== 'ordered'} onRun={run(orderedList)} />
          <ToolButton icon={faListCheck} label={t('documents.editor.tools.checklist')} keys="Mod+Shift+9" active={list === 'check'} onRun={run(toggleChecklist)} />
          <ToolButton icon={faQuoteLeft} label={t('documents.editor.tools.quote')} active={state && inQuote(state)} onRun={run(toggleQuote)} />
        </span>
        <span className="doc-tool-group">
          <ToolButton icon={faImage} label={t('documents.editor.tools.insertImage')} onRun={() => fileRef.current?.click()} />
          <ToolButton icon={faTable} label={t('documents.editor.tools.insertTable')} disabled={inTable} onRun={run(insertTable(3, 3))} />
          <ToolButton icon={faMinus} label={t('documents.editor.tools.horizontalLine')} onRun={run(insertRule)} />
        </span>
        <span className="doc-tool-group">
          <ToolButton icon={faArrowRotateLeft} label={t('documents.editor.tools.undo')} keys="Mod+Z" disabled={!can(undo)} onRun={run(undo)} />
          <ToolButton icon={faArrowRotateRight} label={t('documents.editor.tools.redo')} keys="Mod+Y" disabled={!can(redo)} onRun={run(redo)} />
        </span>
        {inTable && (
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

      {conflict && (
        <div className="doc-conflict" role="alert">
          <span>
            {t('documents.editor.conflict.message')}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={loadTheirs}>{t('documents.editor.conflict.loadTheirs')}</button>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => { setBaseVersion(conflict.document.version); save(conflict.document.version); }}>
            {t('documents.editor.conflict.saveMine')}
          </button>
        </div>
      )}
      {error && <p className="error-msg doc-editor-error" role="alert">{error}</p>}

      <div className="doc-editor-scroll">
        <div className="doc-editor-page">
          {cover ? (
            <div className="doc-editor-cover">
              <DocumentCover cover={cover} />
              <div className="doc-editor-cover-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => coverFileRef.current?.click()}>{t('documents.editor.changeCover')}</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCover(null)}>{t('documents.editor.removeCover')}</button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={`doc-add-cover${coverDragOver ? ' drag-over' : ''}`}
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
              <FontAwesomeIcon icon={faImage} /> {t('documents.editor.addCover')}
            </button>
          )}
          <textarea
            className="doc-editor-title"
            aria-label={t('documents.editor.title')}
            placeholder={t('documents.editor.untitled')}
            rows={1}
            maxLength={MAX_TITLE}
            value={title}
            autoFocus={!document}
            onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
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
          message={document ? t('documents.editor.discard.editing') : t('documents.editor.discard.new')}
          confirmLabel={t('documents.editor.discard.confirm')}
          focusConfirm
          onConfirm={async () => onCancel()}
          onClose={() => setConfirmDiscard(false)}
        />
      )}
    </div>
  );
}
