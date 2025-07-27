import React from 'react';
import Sidebar from './Sidebar';
import { Outlet } from 'react-router-dom';

export default function Layout({ user, onLogout }) {
  return (
    <div className="d-flex">
      <Sidebar user={user} onLogout={onLogout} />
      <div style={{ flex: 1 }}>
        <Outlet />
      </div>
    </div>
  );
}
