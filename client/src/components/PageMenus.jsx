import React, { useCallback, useContext, useEffect, useState } from 'react';
import {
  faArrowUpRightFromSquare, faBook, faCopy, faLink, faPaste, faScissors,
} from '@fortawesome/free-solid-svg-icons';
import { InteractionContext } from '../contexts';
import {
  copyText, cutText, pasteText, replaceClickedWord, selectAllText, spellingOf, textBoxAt,
} from '../utils/editActions';
import { pageMenuTarget } from '../utils/pageMenuTarget';
import { isSpellcheckEnabled, setSpellcheckEnabled } from '../utils/spellcheck';
import { addWord } from '../spellcheck/personalDictionary';
import { openInNewTab } from '../utils/saveFile';
import { copyIdItem } from '../utils/copyId';
import ContextMenu from './ContextMenu';
import ImageMenu from './ImageMenu';
import { displayName } from '../utils/profiles';
import { t } from '../i18n';

// Our menus in place of the browser's, wherever a right-click has nothing of its own (channels,
// messages... handle theirs first): a picture (ImageMenu), a text box (spelling corrections,
// Add to Dictionary, Cut / Copy / Paste / Select All, and Spellcheck on or off), a link to
// another site (Copy Link, Open Link), selected text (Copy) and a person (Copy User ID: anything
// marked `data-user-id`). Mounted once (App), listening
// on the page; Shift+right-click still gets the browser's (utils/nativeContextMenu.js). Not on
// a phone: holding a message opens its actions, a picture in a document its menu
// (useImageHold), and text boxes keep the phone's own.

// How long the menu waits for spelling suggestions before opening without them.
const SPELLING_WAIT_MS = 400;

const copied = async (text, done) => {
  await navigator.clipboard.writeText(text);
  return done;
};

function textBoxItems({ target, spelling }) {
  const items = [];
  if (spelling) {
    for (const suggestion of spelling.suggestions) {
      items.push({ key: `fix-${suggestion}`, label: suggestion, onSelect: () => replaceClickedWord(target, suggestion) });
    }
    if (!spelling.suggestions.length) items.push({ key: 'no-suggestions', label: t('app.pageMenus.noSuggestions'), disabled: true });
    items.push(
      { key: 'add-word', label: t('app.pageMenus.addToDictionary'), icon: faBook, onSelect: () => addWord(target.word.word) },
      { separator: true },
    );
  }
  const { readOnly, hasSelection, secret } = target;
  if (hasSelection && !readOnly && !secret) items.push({ key: 'cut', label: t('app.pageMenus.cut'), icon: faScissors, onSelect: () => cutText(target) });
  if (hasSelection && !secret) items.push({ key: 'copy', label: t('common.copy'), icon: faCopy, onSelect: () => copyText(target) });
  if (!readOnly) items.push({ key: 'paste', label: t('app.pageMenus.paste'), icon: faPaste, onSelect: () => pasteText(target) });
  items.push({ key: 'select-all', label: t('app.pageMenus.selectAll'), onSelect: () => selectAllText(target) });
  if (!secret) {
    const enabled = isSpellcheckEnabled();
    items.push(
      { separator: true },
      { key: 'spellcheck', label: t('app.pageMenus.spellcheck'), checked: enabled, onSelect: () => setSpellcheckEnabled(!enabled) },
    );
  }
  return items;
}

function pageItems({ link, selected, userId }) {
  const items = [];
  if (selected) items.push({ key: 'copy', label: t('common.copy'), icon: faCopy, onSelect: () => copied(selected, t('common.copied')) });
  if (link) {
    if (items.length) items.push({ separator: true });
    items.push(
      { key: 'copy-link', label: t('app.pageMenus.copyLink'), icon: faLink, onSelect: () => copied(link, t('app.pageMenus.linkCopied')) },
      { key: 'open-link', label: t('app.pageMenus.openLink'), icon: faArrowUpRightFromSquare, onSelect: () => openInNewTab(link) },
    );
  }
  if (userId) {
    if (items.length) items.push({ separator: true });
    items.push(copyIdItem('user', userId));
  }
  return items;
}

export default function PageMenus() {
  const { isMobile } = useContext(InteractionContext);
  const [menu, setMenu] = useState(null); // { kind: 'image' | 'text' | 'page', anchor, ... }
  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (isMobile) return undefined;
    let opening = 0;
    const onContextMenu = (e) => {
      if (e.defaultPrevented || e.shiftKey) return;
      const element = e.target?.nodeType === 1 ? e.target : e.target?.parentElement;
      if (!element) return;
      const anchor = { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY };
      const id = ++opening;
      const found = pageMenuTarget(element, document.getSelection()?.toString() ?? '');
      if (!found) {
        setMenu(null);
        return;
      }
      e.preventDefault();
      if (found.kind !== 'text') {
        setMenu({ ...found, anchor });
        return;
      }
      const target = textBoxAt(element, { x: e.clientX, y: e.clientY });
      const wait = new Promise((resolve) => { setTimeout(() => resolve(null), SPELLING_WAIT_MS); });
      Promise.race([spellingOf(target.word?.word).catch(() => null), wait]).then((spelling) => {
        if (id === opening) setMenu({ kind: 'text', target, spelling, anchor });
      });
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, [isMobile]);

  if (!menu) return null;
  if (menu.kind === 'image') return <ImageMenu key={menu.anchor.left + menu.anchor.top} item={menu.item} anchor={menu.anchor} onClose={close} />;
  const items = menu.kind === 'text' ? textBoxItems(menu) : pageItems(menu);
  const label = menu.kind === 'text' ? t('app.pageMenus.text')
    : menu.link ? t('app.pageMenus.link')
      : menu.selected ? t('app.pageMenus.selection')
        : displayName(menu.userId, t('app.pageMenus.user'));
  return <ContextMenu key={`${menu.anchor.left},${menu.anchor.top}`} title={label} label={label} items={items} anchor={menu.anchor} onClose={close} />;
}
