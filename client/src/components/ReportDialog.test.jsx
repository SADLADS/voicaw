// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({ default: { post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

import api from '../utils/api';
import ReportDialog from './ReportDialog';
import BlockedMessage from './BlockedMessage';
import { applyBlocked, isBlocked } from '../utils/blocks';

const dmMessage = { id: 7, sender_id: 5, plaintext: 'you are awful', status: 'sent' };

beforeEach(() => {
  vi.clearAllMocks();
  applyBlocked([]);
  api.post.mockResolvedValue({ data: { id: 1 } });
  api.put.mockResolvedValue({ data: { blocked: [5] } });
});

describe('reporting', () => {
  it("never sends an encrypted message's text unless the reporter ticks to share it", async () => {
    render(<ReportDialog target={{ kind: 'message', place: 'dm', msg: dmMessage }} name="Sam" onClose={() => {}} />);
    const send = screen.getByRole('button', { name: 'Send report' });
    expect(send).toBeDisabled();
    expect(screen.getByLabelText('Let moderators see this message')).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('Harassment or bullying'));
    fireEvent.click(send);
    await screen.findByText(/Thanks for telling us/);
    expect(api.post).toHaveBeenCalledWith('/reports', { kind: 'message', category: 'harassment', place: 'dm', messageId: 7 });
  });

  it('shares the text when ticked, and can block them too', async () => {
    render(<ReportDialog target={{ kind: 'message', place: 'group', msg: dmMessage, groupId: 'g-1' }} name="Sam" onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Harassment or bullying'));
    fireEvent.click(screen.getByLabelText('Let moderators see this message'));
    fireEvent.click(screen.getByLabelText('Also block Sam'));
    fireEvent.change(screen.getByLabelText(/Anything moderators should know/), { target: { value: 'every day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await screen.findByText(/Thanks for telling us/);
    expect(api.post).toHaveBeenCalledWith('/reports', {
      kind: 'message', category: 'harassment', note: 'every day', place: 'group', messageId: 7, groupId: 'g-1', sharedText: 'you are awful',
    });
    expect(api.put).toHaveBeenCalledWith('/blocks/5');
    expect(isBlocked(5)).toBe(true);
  });

  it('has nothing to share for a guild message (the server has it)', () => {
    render(<ReportDialog target={{ kind: 'message', place: 'guild', msg: dmMessage }} name="Sam" onClose={() => {}} />);
    expect(screen.queryByLabelText('Let moderators see this message')).not.toBeInTheDocument();
  });

  it('reports a person', async () => {
    render(<ReportDialog target={{ kind: 'user', userId: 5 }} name="Sam" onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Report Sam' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Spam or scams'));
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/reports', { kind: 'user', category: 'spam', userId: 5 }));
  });
});

describe('a blocked person’s message', () => {
  it('stays collapsed until shown', () => {
    render(<BlockedMessage><p>the message</p></BlockedMessage>);
    expect(screen.getByText('Blocked message')).toBeInTheDocument();
    expect(screen.queryByText('the message')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByText('the message')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('the message')).not.toBeInTheDocument();
  });
});
