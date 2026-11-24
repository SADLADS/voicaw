// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Category permissions (docs/guilds.md): ChannelPermissions for a category, the sync strip of a
// channel in one, and CategoryDialog's tabs and private create.
vi.mock('../../services/guildService', () => ({
  fetchChannelOverrides: vi.fn(),
  fetchCategoryOverrides: vi.fn(),
  setChannelOverride: vi.fn(async () => ({})),
  setCategoryOverride: vi.fn(async () => ({ synced_channels: 2 })),
  syncChannelPermissions: vi.fn(async () => {}),
  fetchMembers: vi.fn(async () => []),
  createCategory: vi.fn(async () => ({ id: 3 })),
  renameCategory: vi.fn(async () => {}),
  deleteCategory: vi.fn(async () => {}),
}));

import ChannelPermissions from './ChannelPermissions';
import CategoryDialog from './CategoryDialog';
import {
  createCategory, fetchCategoryOverrides, fetchChannelOverrides, setCategoryOverride, syncChannelPermissions,
} from '../../services/guildService';
import { PERMISSIONS } from '../../utils/permissions';

const ALL = 2 ** 31 - 1;
const user = { id: 1 };
const category = { id: 2, name: 'Staff', position: 0, my_permissions: ALL, private: false };
const guild = {
  id: 5,
  owner: 1,
  my_permissions: ALL,
  my_role_ids: [],
  roles: [
    { id: 7, name: 'Mods', color: null, position: 1, is_everyone: 0 },
    { id: 5, name: '@everyone', color: null, position: 0, is_everyone: 1 },
  ],
  categories: [category],
  channels: [],
};
const denyView = { target_type: 'role', target_id: 5, allow: 0, deny: PERMISSIONS.VIEW_CHANNEL };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChannelPermissions for a category', () => {
  it('shows every type of permission, saves to the category and says how many channels followed', async () => {
    fetchCategoryOverrides.mockResolvedValue([]);
    render(<ChannelPermissions guild={guild} category={category} user={user} />);
    expect(await screen.findByText('Private category')).toBeInTheDocument();
    // Text, voice and list permissions together.
    expect(screen.getByRole('radiogroup', { name: 'Send Messages' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Edit Tasks' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Deny Send Messages' }));
    await waitFor(() => expect(setCategoryOverride).toHaveBeenCalledWith(5, 2, 'role', 5, { allow: 0, deny: PERMISSIONS.SEND_MESSAGES }));
    expect(await screen.findByText('Also changed in 2 synced channels.')).toBeInTheDocument();
    expect(fetchChannelOverrides).not.toHaveBeenCalled();
  });
});

describe('a channel in a category', () => {
  const channel = { id: 9, name: 'plans', type: 'text', category_id: 2, my_permissions: ALL };

  it('says when it is synced', async () => {
    fetchChannelOverrides.mockResolvedValue([denyView]);
    fetchCategoryOverrides.mockResolvedValue([denyView]);
    render(<ChannelPermissions guild={guild} channel={channel} user={user} />);
    expect(await screen.findByText('Synced with Staff')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('offers Sync now when it is not, and is synced after', async () => {
    fetchChannelOverrides.mockResolvedValue([]);
    fetchCategoryOverrides.mockResolvedValue([denyView]);
    render(<ChannelPermissions guild={guild} channel={channel} user={user} />);
    expect(await screen.findByText(/Not synced with Staff/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(syncChannelPermissions).toHaveBeenCalledWith(5, 9));
    expect(await screen.findByText('Synced with Staff')).toBeInTheDocument();
    // The editor shows the category's overrides now: the channel is private.
    expect(screen.getByRole('checkbox', { name: /Private channel/ })).toBeChecked();
  });

  it('has no strip outside every category', async () => {
    fetchChannelOverrides.mockResolvedValue([]);
    render(<ChannelPermissions guild={guild} channel={{ ...channel, category_id: null }} user={user} />);
    expect(await screen.findByText('Private channel')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(fetchCategoryOverrides).not.toHaveBeenCalled();
  });
});

describe('CategoryDialog', () => {
  it('makes a private category for the roles picked', async () => {
    const onClose = vi.fn();
    render(<CategoryDialog guild={guild} user={user} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Category name'), { target: { value: 'Staff room' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Private category/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mods' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create category' }));
    await waitFor(() => expect(createCategory).toHaveBeenCalledWith(5, 'Staff room', { private: true, roleIds: [7] }));
    expect(onClose).toHaveBeenCalled();
  });

  it('edits a category with Overview and Permissions tabs', async () => {
    fetchCategoryOverrides.mockResolvedValue([]);
    render(<CategoryDialog guild={guild} user={user} category={category} onClose={() => {}} />);
    expect(screen.getByLabelText('Category name')).toHaveValue('Staff');
    fireEvent.click(screen.getByRole('tab', { name: 'Permissions' }));
    expect(await screen.findByText('Private category')).toBeInTheDocument();
    expect(fetchCategoryOverrides).toHaveBeenCalledWith(5, 2);
  });
});
