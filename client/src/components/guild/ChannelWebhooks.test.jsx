// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/guildService', () => ({
  fetchChannelWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
}));

import ChannelWebhooks from './ChannelWebhooks';
import { createWebhook, deleteWebhook, fetchChannelWebhooks, updateWebhook } from '../../services/guildService';

const channel = { id: 4, name: 'general', type: 'text' };
const hook = (over = {}) => ({ id: '9', name: 'Captain Hook', token: 'tok', avatar_url: null, created_at: 1790000000, user: { username: 'otto' }, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});

describe('ChannelWebhooks', () => {
  it("lists the channel's webhooks and makes a new one, opened", async () => {
    fetchChannelWebhooks.mockResolvedValue([hook()]);
    createWebhook.mockResolvedValue(hook({ id: '10' }));
    render(<ChannelWebhooks channel={channel} />);
    expect(await screen.findByText('Captain Hook')).toBeInTheDocument();
    expect(screen.getByText(/by otto/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /New Webhook/ }));
    await waitFor(() => expect(createWebhook).toHaveBeenCalledWith(4, { name: 'Captain Hook' }));
    expect(await screen.findByRole('textbox', { name: 'Webhook name' })).toHaveValue('Captain Hook');
  });

  it('copies its URL, renames it and deletes it (after asking)', async () => {
    fetchChannelWebhooks.mockResolvedValue([hook()]);
    updateWebhook.mockResolvedValue(hook({ name: 'Deploys' }));
    render(<ChannelWebhooks channel={channel} />);
    fireEvent.click(await screen.findByRole('button', { name: /Captain Hook/ }));

    fireEvent.click(screen.getByRole('button', { name: /Copy Webhook URL/ }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('http://localhost:3002/api/webhooks/9/tok'));
    expect(await screen.findByText(/Copied!/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Webhook name' }), { target: { value: ' Deploys ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateWebhook).toHaveBeenCalledWith('9', { name: 'Deploys' }));
    expect(await screen.findByText('Deploys', { selector: '.webhook-name' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Webhook' }));
    expect(deleteWebhook).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteWebhook).toHaveBeenCalledWith('9'));
    expect(await screen.findByText('No webhooks yet.')).toBeInTheDocument();
  });
});
