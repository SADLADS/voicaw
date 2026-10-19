import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { faCheck, faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { errorMessage } from '../utils/guildDisplay';
import { placeMenu as place } from '../utils/menuPlacement';
import { t } from '../i18n';

const ITEMS = '[role^="menuitem"]:not([disabled])';

// A right-click menu (desktop) or a long press's sheet (phone, `sheet`): `items` are
// { key, label, icon?, hint? (a line under it), danger?, disabled?, checked? (true/false: a choice, ticked
// when true), onSelect?, submenu?: { title, items } } or { separator: true }. On a computer it
// floats by `anchor` (a rect) and a submenu opens beside its item on hover, click or →; on a
// phone the sheet rises from the bottom with `title` on top, and a submenu replaces it (with a
// way back). Picking an item runs `onSelect` (given the click: Shift held...) and closes the
// menu as soon as it's done, with nothing to say so (a Copy … item just closes it); if it
// throws, the error shows in the menu instead.
// `header` (desktop) goes above the items, e.g. a message's quick reactions. Escape, or a
// click outside, closes it.
// `overViewer`: shown over the full-screen image viewer (which sits above everything else).
export default function ContextMenu({ title, label, items, header = null, anchor, sheet = false, overViewer = false, onClose }) {
  const rootRef = useRef(null);
  const [submenu, setSubmenu] = useState(null); // { key, anchor (desktop: the item's rect) }
  const [error, setError] = useState(null);
  const open = submenu && items.find((item) => item.key === submenu.key)?.submenu;

  // `fromKeyboard`: Enter, Space or → (the submenu then takes the focus).
  async function pick(item, target, fromKeyboard = false, event = undefined) {
    if (item.submenu) {
      setSubmenu({ key: item.key, anchor: target?.getBoundingClientRect(), target, fromKeyboard });
      return;
    }
    setError(null);
    try {
      await item.onSelect?.(event);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // Escape closes a submenu first (on a computer), then the menu.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (submenu && !sheet) setSubmenu(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submenu, sheet, onClose]);

  // A click outside closes it (the sheet has its backdrop instead).
  useEffect(() => {
    if (sheet) return undefined;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [sheet, onClose]);

  if (sheet) {
    return (
      <SheetMenu
        title={open ? open.title : title}
        label={label}
        items={open ? open.items : items}
        onBack={open ? () => setSubmenu(null) : null}
        onPick={pick}
        error={error}
        onClose={onClose}
        overViewer={overViewer}
      />
    );
  }

  return createPortal(
    <div ref={rootRef} className={`context-menu-root${overViewer ? ' over-viewer' : ''}`}>
      <MenuPanel
        label={label}
        items={items}
        header={header}
        anchor={anchor}
        openKey={submenu?.key}
        onPick={pick}
        onHover={(item, target) => setSubmenu((current) => {
          if (!item.submenu) return null;
          return current?.key === item.key ? current : { key: item.key, anchor: target.getBoundingClientRect(), target };
        })}
        error={error}
        autoFocus
      />
      {open && (
        <MenuPanel
          key={submenu.key}
          label={open.title}
          items={open.items}
          anchor={submenu.anchor}
          beside
          onPick={pick}
          onBack={() => {
            submenu.target?.focus();
            setSubmenu(null);
          }}
          autoFocus={submenu.fromKeyboard}
        />
      )}
    </div>,
    document.body
  );
}

// One floating panel of the desktop menu (the menu, or a submenu `beside` its item).
function MenuPanel({ label, items, header = null, anchor, beside = false, openKey, onPick, onHover, onBack, error, autoFocus }) {
  const ref = useRef(null);
  const [position, setPosition] = useState({ left: anchor.left, top: anchor.bottom, visibility: 'hidden' });

  useLayoutEffect(() => {
    setPosition(place(anchor, ref.current.getBoundingClientRect(), beside));
  }, [anchor, beside]);

  // Focused once it's placed (a hidden element can't take the focus).
  const placed = position.visibility !== 'hidden';
  useEffect(() => {
    if (autoFocus && placed) ref.current?.querySelector(ITEMS)?.focus({ preventScroll: true });
  }, [autoFocus, placed]);

  const onKeyDown = useCallback((e) => {
    const list = [...ref.current.querySelectorAll(ITEMS)];
    const at = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    } else if (e.key === 'ArrowRight' && at >= 0 && list[at].getAttribute('aria-haspopup')) {
      e.preventDefault();
      list[at].click();
    } else if (e.key === 'ArrowLeft' && onBack) {
      e.preventDefault();
      onBack();
    }
  }, [onBack]);

  return (
    <div
      ref={ref}
      className={`guild-menu context-menu${beside ? ' context-submenu' : ''}`}
      style={position}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {header}
      {items.map((item, i) => (item.separator
        ? <div key={`sep-${i}`} className="guild-menu-separator" role="separator" />
        : (
          <button
            key={item.key}
            type="button"
            disabled={item.disabled}
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? openKey === item.key : undefined}
            className={`guild-menu-item${item.danger ? ' danger' : ''}${openKey === item.key ? ' open' : ''}`}
            onMouseEnter={onHover ? (e) => onHover(item, e.currentTarget) : undefined}
            onClick={(e) => onPick(item, e.currentTarget, e.detail === 0, e)}
          >
            <span className="context-menu-label">
              {item.label}
              {item.hint && <small>{item.hint}</small>}
            </span>
            {item.submenu && <Icon icon={faChevronRight} />}
            {!item.submenu && item.checked !== undefined && (
              <span className={`context-menu-check${item.checked ? ' on' : ''}`}>{item.checked && <Icon icon={faCheck} />}</span>
            )}
            {!item.submenu && item.checked === undefined && item.icon && <Icon icon={item.icon} />}
          </button>
        )))}
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>
  );
}

// The phone's version: a sheet from the bottom, like a message's actions.
function SheetMenu({ title, label, items, onBack, onPick, error, onClose, overViewer }) {
  // A click only counts from a touch that started on the sheet (not the finger lifting from
  // the long press that opened it).
  const touchedHere = useRef(false);
  return createPortal(
    <div
      className={`action-sheet-backdrop${overViewer ? ' over-viewer' : ''}`}
      onPointerDown={() => { touchedHere.current = true; }}
      onClickCapture={(e) => {
        if (!touchedHere.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="action-sheet context-sheet" role="menu" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="context-sheet-title">
          {onBack && (
            <button type="button" className="context-sheet-back" aria-label={t('common.back')} onClick={onBack}>
              <Icon icon={faChevronLeft} />
            </button>
          )}
          <span>{title}</span>
        </div>
        <div className="action-sheet-items">
          {items.map((item, i) => (item.separator
            ? <div key={`sep-${i}`} className="context-sheet-separator" role="separator" />
            : (
              <button
                key={item.key}
                type="button"
                disabled={item.disabled}
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.checked}
                aria-haspopup={item.submenu ? 'menu' : undefined}
                className={`action-sheet-item${item.danger ? ' danger' : ''}`}
                onClick={(e) => onPick(item, e.currentTarget, false, e)}
              >
                {item.icon && <Icon icon={item.icon} fixedWidth />}
                <span className="context-menu-label">
                  {item.label}
                  {item.hint && <small>{item.hint}</small>}
                </span>
                {item.submenu && <Icon icon={faChevronRight} className="context-sheet-end" />}
                {item.checked && <Icon icon={faCheck} className="context-sheet-end" />}
              </button>
            )))}
        </div>
        {error && <p className="error-msg" role="alert">{error}</p>}
      </div>
    </div>,
    document.body
  );
}
