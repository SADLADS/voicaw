import { AllSelection } from 'prosemirror-state';
import { desktop } from './desktop';
import { isSpellcheckEnabled, spellcheckLanguage } from './spellcheck';
import { checkWord, suggestions } from '../spellcheck/checker';
import { hasWord } from '../spellcheck/personalDictionary';
import { replaceWord, spellcheckViewOf, wordAtPos } from '../spellcheck/spellcheckPlugin';
import { wordAt } from '../spellcheck/words';
import { t } from '../i18n';

// What the text box menu (PageMenus) does: where a right-click in a text box is (`textBoxAt`),
// and cut, copy, paste, select all and spelling corrections there. The menu takes the focus
// while it's open, so each action puts it back in the box first: a ProseMirror editor keeps its
// selection in its state, a plain field in selectionStart/End.

const EDITABLE = 'input, textarea, [contenteditable=""], [contenteditable="true"]';
const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number']);

// The text box `element` is in, or null (checkboxes, buttons and the like aren't).
export function editableAt(element) {
  const box = element?.closest?.(EDITABLE);
  if (!box) return null;
  if (box.matches('input') && !TEXT_INPUTS.has(box.type)) return null;
  return box;
}

// A right-click at (x, y) on `element`, a text box: { box, view, start, end, hasSelection,
// readOnly, secret, word } (`word` { word, from, to } is the word clicked on, if any).
export function textBoxAt(element, { x, y }) {
  const view = spellcheckViewOf(element);
  if (view) {
    const pos = view.posAtCoords({ left: x, top: y })?.pos;
    return {
      box: view.dom,
      view,
      hasSelection: !view.state.selection.empty,
      readOnly: !view.editable,
      secret: false,
      word: pos == null ? null : wordAtPos(view, pos),
    };
  }
  const box = editableAt(element);
  const plain = box && typeof box.selectionStart === 'number';
  const start = plain ? box.selectionStart : 0;
  const end = plain ? box.selectionEnd : 0;
  const secret = box?.type === 'password';
  let word = null;
  // The browser puts the caret where it was right-clicked (unless that was in the selection).
  if (plain && !secret) {
    const found = wordAt(box.value, start);
    if (found && (start === end || (found.from === start && found.to === end))) word = found;
  }
  return {
    box,
    view: null,
    start,
    end,
    hasSelection: plain ? start !== end : Boolean(document.getSelection()?.toString()),
    readOnly: Boolean(box?.readOnly || box?.disabled),
    secret,
    word,
  };
}

function refocus(target) {
  if (target.view) {
    target.view.focus();
    return;
  }
  target.box.focus({ preventScroll: true });
  if (typeof target.box.setSelectionRange === 'function') target.box.setSelectionRange(target.start, target.end);
}

// `failed`: the message shown when the browser won't do it.
function run(command, failed) {
  if (!document.execCommand(command)) throw new Error(failed);
}

export function cutText(target) {
  refocus(target);
  run('cut', t('chat.editActions.cutFailed'));
}

export function copyText(target) {
  refocus(target);
  run('copy', t('chat.editActions.copyFailed'));
}

export function selectAllText(target) {
  refocus(target);
  if (target.view) target.view.dispatch(target.view.state.tr.setSelection(new AllSelection(target.view.state.doc)));
  else target.box.select?.();
}

// What's on the clipboard, as a DataTransfer (text, HTML and pictures), for a ProseMirror
// editor to paste the way it handles a real paste (the message box attaches pictures).
async function clipboardTransfer() {
  const transfer = new DataTransfer();
  if (navigator.clipboard?.read) {
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) {
        const blob = await item.getType(type);
        if (type === 'text/plain' || type === 'text/html') transfer.setData(type, await blob.text());
        else if (type.startsWith('image/')) transfer.items.add(new File([blob], `pasted.${type.split('/')[1]}`, { type }));
      }
    }
  } else {
    transfer.setData('text/plain', await navigator.clipboard.readText());
  }
  return transfer;
}

// The desktop app pastes for real (Electron's own paste); a browser has to ask to read the
// clipboard (the first time, it asks the person).
export async function pasteText(target) {
  refocus(target);
  if (desktop?.paste) {
    desktop.paste();
    return;
  }
  if (!navigator.clipboard?.readText) throw new Error(t('chat.editActions.pasteUnsupported'));
  try {
    if (target.view) {
      const clipboardData = await clipboardTransfer();
      refocus(target);
      target.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    } else {
      const text = await navigator.clipboard.readText();
      refocus(target);
      document.execCommand('insertText', false, text);
    }
  } catch (err) {
    if (err?.name === 'NotAllowedError') throw new Error(t('chat.editActions.pasteBlocked'));
    throw err;
  }
}

// Puts `replacement` in place of the word right-clicked.
export function replaceClickedWord(target, replacement) {
  if (target.view) {
    replaceWord(target.view, target.word, replacement);
    return;
  }
  target.box.focus({ preventScroll: true });
  target.box.setSelectionRange(target.word.from, target.word.to);
  // As if typed: the field's own undo and its onChange both see it.
  document.execCommand('insertText', false, replacement);
}

// Whether `word` is misspelled and what could replace it: { suggestions } or null. Our checker
// when it's the one checking; otherwise the desktop app's own (its languages), or nothing in
// a browser.
export async function spellingOf(word) {
  if (!word || !isSpellcheckEnabled() || hasWord(word)) return null;
  if (spellcheckLanguage()) {
    if (!(await checkWord(word))) return null;
    return { suggestions: await suggestions(word) };
  }
  const desktopSpelling = desktop?.spelling;
  if (desktopSpelling?.isMisspelled(word)) return { suggestions: desktopSpelling.suggestions(word).slice(0, 5) };
  return null;
}
