import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

// A dialog over everything: `title`, content, and `actions` (buttons) at the bottom. Closes on
// Escape (unless something open over it, like an emoji picker, already handled it) or a click
// on the backdrop.
export default function Modal({ title, onClose, children, actions, className = '' }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="vc-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`vc-dialog ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="vc-dialog-header">
          <h5>{title}</h5>
          <button type="button" className="vc-dialog-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="vc-dialog-body">{children}</div>
        {actions && <div className="vc-dialog-actions">{actions}</div>}
      </div>
    </div>,
    document.body
  );
}
