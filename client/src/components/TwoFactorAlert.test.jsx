// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

vi.mock('../services/authService', () => ({ dismissTwoFactorFailures: vi.fn(async () => ({ ok: true })) }));

import TwoFactorAlert from './TwoFactorAlert';
import { AuthContext } from '../hooks/useAuth';
import { dismissTwoFactorFailures } from '../services/authService';

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.hash}</p>;
}

function renderAlert(initial) {
  function Provider() {
    const [user, setUser] = useState(initial);
    return (
      <AuthContext.Provider value={{ user, setUser }}>
        <MemoryRouter>
          <TwoFactorAlert />
          <Routes><Route path="*" element={<Where />} /></Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    );
  }
  return render(<Provider />);
}

beforeEach(() => vi.clearAllMocks());

describe('TwoFactorAlert', () => {
  it('warns about wrong two-factor codes until dismissed, everywhere', () => {
    renderAlert({ id: 1, twoFactorFailures: 12 });
    expect(screen.getByRole('alert')).toHaveTextContent('12 wrong two-factor codes were typed');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(dismissTwoFactorFailures).toHaveBeenCalledTimes(1);
  });

  it('Change password opens the password settings and clears it', () => {
    renderAlert({ id: 1, twoFactorFailures: 1 });
    expect(screen.getByRole('alert')).toHaveTextContent('1 wrong two-factor code was typed');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/account#password');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(dismissTwoFactorFailures).toHaveBeenCalled();
  });

  it('shows nothing without failures, logged out, or while waiting for approval', () => {
    for (const user of [null, { id: 1 }, { id: 1, twoFactorFailures: 0 }, { id: 1, twoFactorFailures: 3, pending: true }]) {
      const { unmount } = renderAlert(user);
      expect(screen.queryByRole('alert')).toBeNull();
      unmount();
    }
  });
});
