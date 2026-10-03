import { useRef } from 'react';
import { SIDEBAR_WIDTH, clampSidebarWidth } from '../utils/sidebarWidth';
import { t } from '../i18n';

// The right edge of the column beside the rail (computer only): drag it to make the DM list,
// channel list and Settings' column wider or narrower, all at once. While dragging, the width
// goes straight onto `targetRef`'s --vc-sidebar-width (no re-render per move); `onChange` gets
// the final width on release. Arrow keys move it too, and a double click goes back to the
// default.
export default function SidebarResizer({ width, onChange, targetRef }) {
  const drag = useRef(null);

  const apply = (next) => targetRef.current?.style.setProperty('--vc-sidebar-width', `${next}px`);

  const finish = (e) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    document.body.classList.remove('sidebar-resizing');
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onChange(current.width);
  };

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('app.sidebar.resize')}
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      title={t('app.sidebar.dragToResize')}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startWidth: width, width };
        document.body.classList.add('sidebar-resizing');
      }}
      onPointerMove={(e) => {
        const current = drag.current;
        if (!current) return;
        const next = clampSidebarWidth(current.startWidth + e.clientX - current.startX, window.innerWidth);
        if (next === current.width) return;
        current.width = next;
        apply(next);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => {
        apply(SIDEBAR_WIDTH.default);
        onChange(SIDEBAR_WIDTH.default);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        let next = null;
        if (e.key === 'ArrowLeft') next = width - step;
        else if (e.key === 'ArrowRight') next = width + step;
        else if (e.key === 'Home') next = SIDEBAR_WIDTH.min;
        else if (e.key === 'End') next = SIDEBAR_WIDTH.max;
        if (next == null) return;
        e.preventDefault();
        next = clampSidebarWidth(next, window.innerWidth);
        apply(next);
        onChange(next);
      }}
    />
  );
}
