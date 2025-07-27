import React from 'react';

export default function Dashboard({ user, onLogout }) {
  return (
    <div style={{ padding: '2rem', color: 'var(--vc-white)', backgroundColor: 'var(--vc-grey-dark)', minHeight: '100vh' }}>
      <h1>Welcome, {user.username}!</h1>
      <p>You are now logged in.</p>
      <button className="btn btn-secondary" onClick={onLogout}>Logout</button>
    </div>
  );
}
