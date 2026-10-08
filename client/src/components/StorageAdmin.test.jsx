// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn() },
}));

import api from '../utils/api';
import StorageAdmin from './StorageAdmin';

const GB = 1024 ** 3;
const stats = (over = {}) => ({
  available: true,
  total: 100 * GB,
  free: 60 * GB,
  buckets: [
    { name: 'uploads', bytes: 20 * GB, objects: 1200 },
    { name: 'profile-pics', bytes: 5 * 1024 ** 2, objects: 1 },
    { name: 'guild-icons', bytes: 0, objects: 0 },
    { name: 'emojis', bytes: 2048, objects: 3 },
  ],
  otherBuckets: { bytes: 0, objects: 0 },
  checkedAt: Date.now(),
  ...over,
});

beforeEach(() => {
  api.get.mockReset();
});

describe('StorageAdmin', () => {
  it('shows free space, each bucket and everything else on the drive', async () => {
    api.get.mockResolvedValue({ data: stats() });
    render(<StorageAdmin />);
    expect(await screen.findByText('60 GB free of 100 GB (60%)')).toBeTruthy();
    expect(screen.getByText('Attachments')).toBeTruthy();
    expect(screen.getByText('20 GB · 1200 files')).toBeTruthy();
    expect(screen.getByText('5.0 MB · 1 file')).toBeTruthy();
    // 100 - 60 free - ~20 Voicaw: what was put on the drive some other way.
    expect(screen.getByText('Everything else on the drive')).toBeTruthy();
    expect(screen.getByText('20 GB')).toBeTruthy();
    expect(screen.queryByText('Other buckets on the store')).toBeNull();
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('40 GB of 100 GB used');
    expect(api.get).toHaveBeenCalledWith('/admin/storage');
  });

  it('lists other buckets when the store has them, and warns when nearly full', async () => {
    api.get.mockResolvedValue({ data: stats({ free: 5 * GB, otherBuckets: { bytes: 3 * GB, objects: 9 } }) });
    render(<StorageAdmin />);
    const free = await screen.findByText('5.0 GB free of 100 GB (5%)');
    expect(free.classList.contains('low')).toBe(true);
    expect(screen.getByText('Other buckets on the store')).toBeTruthy();
    expect(screen.getByText('3.0 GB · 9 files')).toBeTruthy();
  });

  it("says so when the store doesn't report its space", async () => {
    api.get.mockResolvedValue({ data: { available: false, checkedAt: Date.now() } });
    render(<StorageAdmin />);
    expect(await screen.findByText(/doesn't say how much space it has/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('Attachments')).toBeNull();
  });

  it('Refresh asks the store again', async () => {
    api.get.mockResolvedValue({ data: stats() });
    render(<StorageAdmin />);
    await screen.findByText('60 GB free of 100 GB (60%)');
    api.get.mockResolvedValue({ data: stats({ free: 50 * GB }) });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('50 GB free of 100 GB (50%)')).toBeTruthy();
    expect(api.get).toHaveBeenLastCalledWith('/admin/storage?fresh=1');
  });

  it('shows an error when the request fails', async () => {
    api.get.mockRejectedValue(new Error('nope'));
    render(<StorageAdmin />);
    await waitFor(() => expect(screen.getByText("Couldn't load the storage figures")).toBeTruthy());
  });
});
