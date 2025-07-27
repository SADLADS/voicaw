import React from 'react';

export default function Dashboard({ user, onLogout }) {
  return (
    <div style={{ display: 'flex' }}>
      <div
        style={{
          padding: '2rem',
          color: 'var(--vc-white)',
          backgroundColor: 'var(--vc-grey-dark)',
          minHeight: '100vh',
          flex: 1,
        }}
      >
        <h1>Welcome, {user.username}!</h1>
        <p>You are now logged in.</p>
      </div>
    </div>
  );
}
