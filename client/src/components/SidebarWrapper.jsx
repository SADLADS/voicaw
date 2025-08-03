import React from 'react';

export default function SidebarWrapper({ children }) {
  return (
    <div className="d-flex flex-row sidebar-wrapper" style={{ height: '100vh' }}>
      {children}
    </div>
  );
}