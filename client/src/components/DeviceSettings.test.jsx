// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), delete: vi.fn() },
}));

import api from '../utils/api';
import DeviceSettings from './DeviceSettings';

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

const session = (id, over = {}) => ({
  id, created_at: 1790000000, last_used_at: 1790500000, ip: '203.0.113.7', current: false, online: false, ...over,
});
const here = session('here', { user_agent: CHROME_WINDOWS, current: true });
const phone = session('phone', { user_agent: SAFARI_IPHONE, online: true });
const laptop = session('laptop', { user_agent: FIREFOX_LINUX });

beforeEach(() => vi.clearAllMocks());

const rowOf = (name) => screen.getByText(name).closest('li');

describe('DeviceSettings', () => {
  it('lists every device, marking this one and the ones online', async () => {
    api.get.mockResolvedValue({ data: [here, phone, laptop] });
    render(<DeviceSettings />);
    expect(await screen.findByText('Chrome on Windows')).toBeInTheDocument();
    expect(within(rowOf('Chrome on Windows')).getByText('This device')).toBeInTheDocument();
    expect(within(rowOf('Chrome on Windows')).queryByRole('button')).toBeNull();
    expect(within(rowOf('Safari on iPhone')).getByText('Online now')).toBeInTheDocument();
    expect(within(rowOf('Firefox on Linux')).getByText(/^Last active /)).toBeInTheDocument();
    expect(rowOf('Firefox on Linux')).toHaveTextContent('203.0.113.7');
    expect(api.get).toHaveBeenCalledWith('/sessions');
  });

  it('logs one device out', async () => {
    api.get.mockResolvedValue({ data: [here, phone, laptop] });
    api.delete.mockResolvedValue({ data: [here, laptop] });
    render(<DeviceSettings />);
    await screen.findByText('Safari on iPhone');
    fireEvent.click(within(rowOf('Safari on iPhone')).getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.queryByText('Safari on iPhone')).toBeNull());
    expect(api.delete).toHaveBeenCalledWith('/sessions/phone');
    expect(screen.getByText('Firefox on Linux')).toBeInTheDocument();
  });

  it('logs every other device out after asking', async () => {
    api.get.mockResolvedValue({ data: [here, phone, laptop] });
    api.delete.mockResolvedValue({ data: [here] });
    render(<DeviceSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Log out all other devices' }));
    expect(screen.getByText(/All 2 other devices will have to log in again/)).toBeInTheDocument();
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.queryByText('Firefox on Linux')).toBeNull());
    expect(api.delete).toHaveBeenCalledWith('/sessions');
    expect(screen.queryByRole('button', { name: 'Log out all other devices' })).toBeNull();
  });

  it('says when the list cannot be loaded', async () => {
    api.get.mockRejectedValue(new Error('offline'));
    render(<DeviceSettings />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your devices");
  });
});
