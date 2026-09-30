import React from 'react';

// The left side: the sidebars in a row, with `footer` (the user panel) across the bottom.
export default function SidebarWrapper({ children, footer, ref }) {
  return (
    <div ref={ref} className="sidebar-wrapper">
      <div className="sidebar-columns">{children}</div>
      {footer}
    </div>
  );
}