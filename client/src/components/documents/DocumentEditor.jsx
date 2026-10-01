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

const MAX_TITLE = 200;
const MAX_CONTENT = 100000;

const BLOCK_STYLES = [
  ['paragraph', 'Normal text'],
  ['h1', 'Heading 1'],
  ['h2', 'Heading 2'],
  ['h3', 'Heading 3'],
  ['h4', 'Heading 4'],
  ['code', 'Code block'],
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

function ToolButton({ icon, label, keys, active = false, disabled = false, onRun, children }) {
  return (
    <button
      type="button"
      className={`doc-tool${active ? ' active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={keys ? `${label} (${shortcut(keys)})` : label}
      disabled={disabled}
      // Keep the editor's selection: run without taking focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
    >
      {icon ? <FontAwesomeIcon icon={icon} /> : children}
    </button>
  );
}

// Writing or editing a document, like a word processor: title, optional cover image, and
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
        setError(`Couldn't upload ${file.name}: ${errorMessage(err)}`);
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
      attributes: { class: 'doc-editor-text document-body', 'aria-label': 'Document', spellcheck: 'true' },
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
      setError('Give the document a title.');
      return;
    }
    if (text.length > MAX_CONTENT) {
      setError(`Documents are at most ${MAX_CONTENT.toLocaleString()} characters (this one is ${text.length.toLocaleString()}).`);
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
      setError(`Couldn't upload the cover: ${errorMessage(err)}`);
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
        <button type="button" className="btn btn-secondary btn-sm" onClick={cancel} disabled={saving}>Cancel</button>
        <span className="doc-editor-status" role="status">
          {uploading > 0 ? 'Uploading image…' : saving ? 'Saving…' : ''}
        </span>
        <button type="button" className="btn btn-primary btn-sm vc-button" onClick={() => save()} disabled={saving || uploading > 0}>
          {document ? 'Save' : 'Publish'}
        </button>
      </div>

      <div className="doc-toolbar" role="toolbar" aria-label="Formatting">
        <select
          className="doc-style-select form-select form-select-sm"
          aria-label="Text style"
          value={style ?? ''}
          onChange={(e) => {
            const choice = e.target.value;
            run(choice === 'paragraph' ? makeParagraph : choice === 'code' ? makeCodeBlock : makeHeading(Number(choice.slice(1))))();
          }}
        >
          {style == null && <option value="">Mixed</option>}
          {style && /^h[56]$/.test(style) && <option value={style}>Heading {style.slice(1)}</option>}
          {BLOCK_STYLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <span className="doc-tool-group">
          <ToolButton icon={faBold} label="Bold" keys="Mod+B" active={state && markActive(state, schema.marks.strong)} onRun={run(toggleBold)} />
          <ToolButton icon={faItalic} label="Italic" keys="Mod+I" active={state && markActive(state, schema.marks.em)} onRun={run(toggleItalic)} />
          <ToolButton icon={faUnderline} label="Underline" keys="Mod+U" active={state && markActive(state, schema.marks.underline)} onRun={run(toggleUnderline)} />
          <ToolButton icon={faStrikethrough} label="Strikethrough" keys="Mod+Shift+X" active={state && markActive(state, schema.marks.strike)} onRun={run(toggleStrike)} />
          <ToolButton icon={faCode} label="Inline code" keys="Mod+E" active={state && markActive(state, schema.marks.code)} onRun={run(toggleCode)} />
          <ToolButton icon={faEyeSlash} label="Spoiler" active={state && markActive(state, schema.marks.spoiler)} onRun={run(toggleSpoiler)} />
          <ToolButton
            icon={faLink}
            label={state && linkActive(state) ? 'Remove link' : 'Link'}
            active={state && linkActive(state)}
            onRun={() => (state && linkActive(state) ? run(setLink(null))() : setLinkDraft(''))}
          />
        </span>
        <span className="doc-tool-group">
          <ToolButton icon={faListUl} label="Bulleted list" keys="Mod+Shift+8" active={list === 'bullet'} disabled={!can(bulletList) && list !== 'bullet'} onRun={run(bulletList)} />
          <ToolButton icon={faListOl} label="Numbered list" keys="Mod+Shift+7" active={list === 'ordered'} disabled={!can(orderedList) && list !== 'ordered'} onRun={run(orderedList)} />
          <ToolButton icon={faListCheck} label="Checklist" keys="Mod+Shift+9" active={list === 'check'} onRun={run(toggleChecklist)} />
          <ToolButton icon={faQuoteLeft} label="Quote" active={state && inQuote(state)} onRun={run(toggleQuote)} />
        </span>
        <span className="doc-tool-group">
          <ToolButton icon={faImage} label="Insert image" onRun={() => fileRef.current?.click()} />
          <ToolButton icon={faTable} label="Insert table" disabled={inTable} onRun={run(insertTable(3, 3))} />
          <ToolButton icon={faMinus} label="Horizontal line" onRun={run(insertRule)} />
        </span>
        <span className="doc-tool-group">
          <ToolButton icon={faArrowRotateLeft} label="Undo" keys="Mod+Z" disabled={!can(undo)} onRun={run(undo)} />
          <ToolButton icon={faArrowRotateRight} label="Redo" keys="Mod+Y" disabled={!can(redo)} onRun={run(redo)} />
        </span>
        {inTable && (
          <span className="doc-tool-group doc-table-tools" aria-label="Table">
            <ToolButton label="Add row below" onRun={run(addRowAfter)}>+ Row</ToolButton>
            <ToolButton label="Add column to the right" onRun={run(addColumnAfter)}>+ Column</ToolButton>
            <ToolButton label="Delete row" disabled={!can(deleteRow)} onRun={run(deleteRow)}>− Row</ToolButton>
            <ToolButton label="Delete column" disabled={!can(deleteColumn)} onRun={run(deleteColumn)}>− Column</ToolButton>
            <ToolButton label="Delete table" onRun={run(deleteTable)}>Delete table</ToolButton>
          </span>
        )}
        {linkDraft != null && (
          <form className="doc-link-form" onSubmit={applyLink}>
            <input
              className="form-control form-control-sm"
              aria-label="Link address"
              placeholder="Paste or type a link"
              value={linkDraft}
              autoFocus
              onChange={(e) => setLinkDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setLinkDraft(null); view?.focus(); } }}
            />
            <button type="submit" className="btn btn-primary btn-sm vc-button">Add link</button>
          </form>
        )}
        <input ref={fileRef} type="file" accept="image/*" multiple hidden aria-label="Image file" onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />
        <input ref={coverFileRef} type="file" accept="image/*" hidden aria-label="Cover image file" onChange={(e) => { pickCover(e.target.files?.[0]); e.target.value = ''; }} />
      </div>

      {conflict && (
        <div className="doc-conflict" role="alert">
          <span>
            Someone else saved this document while you were editing it.
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={loadTheirs}>Load their version</button>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => { setBaseVersion(conflict.document.version); save(conflict.document.version); }}>
            Save mine over it
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
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => coverFileRef.current?.click()}>Change cover</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCover(null)}>Remove cover</button>
              </div>
            </div>
          ) : (
            <button type="button" className="doc-add-cover" onClick={() => coverFileRef.current?.click()}>
              <FontAwesomeIcon icon={faImage} /> Add a cover image
            </button>
          )}
          <textarea
            className="doc-editor-title"
            aria-label="Title"
            placeholder="Untitled document"
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
          title="Discard changes"
          message={document ? 'Stop editing and lose your changes?' : 'Throw this document away?'}
          confirmLabel="Discard"
          focusConfirm
          onConfirm={async () => onCancel()}
          onClose={() => setConfirmDiscard(false)}
        />
      )}
    </div>
  );
}
