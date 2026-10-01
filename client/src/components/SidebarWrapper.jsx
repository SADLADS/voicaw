import React from 'react';

// The left side: the sidebars in a row, with `footer` (the user panel) across the bottom, and
// `resizer` (SidebarResizer) on its right edge.
export default function SidebarWrapper({ children, footer, resizer, ref }) {
  return (
    <div ref={ref} className="sidebar-wrapper">
      <div className="sidebar-columns">{children}</div>
      {footer}
      {resizer}
    </div>
  );
}