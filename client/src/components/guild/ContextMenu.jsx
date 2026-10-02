import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { errorMessage } from '../../utils/guildDisplay';
import { placeMenu as place } from '../../utils/menuPlacement';

const ITEMS = '[role^="menuitem"]:not([disabled])';

// A right-click menu (desktop) or a long press's sheet (phone, `sheet`): `items` are
// { key, label, icon?, hint? (a line under it), danger?, checked? (true/false: a choice, ticked
// when true), onSelect?, submenu?: { title, items } } or { separator: true }. On a computer it
// floats by `anchor` (a rect) and a submenu opens beside its item on hover, click or →; on a
// phone the sheet rises from the bottom with `title` on top, and a submenu replaces it (with a
// way back). Picking an item runs `onSelect` and closes the menu once it's done; if it throws,
// the error shows in the menu instead. `onSelect` returning a string shows it in place of the
// item's label for a moment first ("Link copied"). Escape, or a click outside, closes it.
export default function ContextMenu({ title, label, items, anchor, sheet = false, onClose }) {
  const rootRef = useRef(null);
  const [submenu, setSubmenu] = useState(null); // { key, anchor (desktop: the item's rect) }
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // { key, text }
  const closeTimer = useRef(null);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const open = submenu && items.find((item) => item.key === submenu.key)?.submenu;

  // `fromKeyboard`: Enter, Space or → (the submenu then takes the focus).
  async function pick(item, target, fromKeyboard = false) {
    if (item.submenu) {
      setSubmenu({ key: item.key, anchor: target?.getBoundingClientRect(), target, fromKeyboard });
      return;
    }
    setError(null);
    try {
      const result = await item.onSelect?.();
      if (typeof result === 'string') {
        setDone({ key: item.key, text: result });
        closeTimer.current = setTimeout(onClose, 700);
      } else {
        onClose();
      }
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
        done={done}
        error={error}
        onClose={onClose}
      />
    );
  }

  return createPortal(
    <div ref={rootRef} className="context-menu-root">
      <MenuPanel
        label={label}
        items={items}
        anchor={anchor}
        openKey={submenu?.key}
        onPick={pick}
        onHover={(item, target) => setSubmenu((current) => {
          if (!item.submenu) return null;
          return current?.key === item.key ? current : { key: item.key, anchor: target.getBoundingClientRect(), target };
        })}
        done={done}
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
          done={done}
          autoFocus={submenu.fromKeyboard}
        />
      )}
    </div>,
    document.body
  );
}

// One floating panel of the desktop menu (the menu, or a submenu `beside` its item).
function MenuPanel({ label, items, anchor, beside = false, openKey, onPick, onHover, onBack, done, error, autoFocus }) {
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
      {items.map((item, i) => (item.separator
        ? <div key={`sep-${i}`} className="guild-menu-separator" role="separator" />
        : (
          <button
            key={item.key}
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? openKey === item.key : undefined}
            className={`guild-menu-item${item.danger ? ' danger' : ''}${openKey === item.key ? ' open' : ''}`}
            onMouseEnter={onHover ? (e) => onHover(item, e.currentTarget) : undefined}
            onClick={(e) => onPick(item, e.currentTarget, e.detail === 0)}
          >
            <span className="context-menu-label">
              {done?.key === item.key ? done.text : item.label}
              {item.hint && <small>{item.hint}</small>}
            </span>
            {item.submenu && <FontAwesomeIcon icon={faChevronRight} />}
            {!item.submenu && item.checked !== undefined && (
              <span className={`context-menu-check${item.checked ? ' on' : ''}`}>{item.checked && <FontAwesomeIcon icon={faCheck} />}</span>
            )}
            {!item.submenu && item.checked === undefined && item.icon && <FontAwesomeIcon icon={item.icon} />}
          </button>
        )))}
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>
  );
}

// The phone's version: a sheet from the bottom, like a message's actions.
function SheetMenu({ title, label, items, onBack, onPick, done, error, onClose }) {
  // A click only counts from a touch that started on the sheet (not the finger lifting from
  // the long press that opened it).
  const touchedHere = useRef(false);
  return createPortal(
    <div
      className="action-sheet-backdrop"
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
            <button type="button" className="context-sheet-back" aria-label="Back" onClick={onBack}>
              <FontAwesomeIcon icon={faChevronLeft} />
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
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.checked}
                aria-haspopup={item.submenu ? 'menu' : undefined}
                className={`action-sheet-item${item.danger ? ' danger' : ''}`}
                onClick={(e) => onPick(item, e.currentTarget)}
              >
                {item.icon && <FontAwesomeIcon icon={item.icon} fixedWidth />}
                <span className="context-menu-label">
                  {done?.key === item.key ? done.text : item.label}
                  {item.hint && <small>{item.hint}</small>}
                </span>
                {item.submenu && <FontAwesomeIcon icon={faChevronRight} className="context-sheet-end" />}
                {item.checked && <FontAwesomeIcon icon={faCheck} className="context-sheet-end" />}
              </button>
            )))}
        </div>
        {error && <p className="error-msg" role="alert">{error}</p>}
      </div>
    </div>,
    document.body
  );
}
