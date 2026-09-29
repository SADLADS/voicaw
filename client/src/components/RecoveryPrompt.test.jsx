// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RecoveryPrompt from './RecoveryPrompt';

const renderPrompt = (user) => render(<MemoryRouter><RecoveryPrompt user={user} /></MemoryRouter>);

beforeEach(() => localStorage.clear());

describe('RecoveryPrompt', () => {
  it('asks accounts without a recovery code to set one up, until dismissed', () => {
    const { unmount } = renderPrompt({ id: 1, hasRecoveryCode: false });
    expect(screen.getByText(/Set up a recovery code/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Set up a recovery code/)).toBeNull();
    unmount();

    renderPrompt({ id: 1, hasRecoveryCode: false });
    expect(screen.queryByText(/Set up a recovery code/)).toBeNull();
  });

  it('stays hidden when there is a code, or before the profile says', () => {
    renderPrompt({ id: 1, hasRecoveryCode: true });
    renderPrompt({ id: 1 });
    expect(screen.queryByText(/Set up a recovery code/)).toBeNull();
  });
});
