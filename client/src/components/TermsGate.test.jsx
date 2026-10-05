// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({ default: { post: vi.fn() } }));

import api from '../utils/api';
import TermsGate from './TermsGate';
import { ConfigContext } from '../contexts';

const show = (props) => render(
  <ConfigContext.Provider value={{ termsVersion: '2026-10-05' }}>
    <TermsGate onAccepted={vi.fn()} onLogout={vi.fn()} {...props} />
  </ConfigContext.Provider>
);

beforeEach(() => vi.clearAllMocks());

describe('accepting the terms of use', () => {
  it('links the terms and agrees to the version shown, once ticked', async () => {
    api.post.mockResolvedValue({ data: { termsAccepted: true } });
    const onAccepted = vi.fn();
    show({ onAccepted });
    expect(screen.getByRole('link', { name: 'Read the terms of use' })).toHaveAttribute('href', 'https://voicaw.com/terms/');
    const go = screen.getByRole('button', { name: 'Agree and continue' });
    expect(go).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I agree to the terms of use and I'm 13 or over"));
    fireEvent.click(go);
    await waitFor(() => expect(onAccepted).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/terms/accept', { version: '2026-10-05' });
  });

  it('stays when it could not be saved, and can log out instead', async () => {
    api.post.mockRejectedValue(new Error('offline'));
    const onAccepted = vi.fn();
    const onLogout = vi.fn();
    show({ onAccepted, onLogout });
    fireEvent.click(screen.getByLabelText("I agree to the terms of use and I'm 13 or over"));
    fireEvent.click(screen.getByRole('button', { name: 'Agree and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that");
    expect(onAccepted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(onLogout).toHaveBeenCalled();
  });
});
