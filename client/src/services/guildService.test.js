import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(async () => ({ data: {} })), post: vi.fn(async () => ({ data: {} })) },
}));

import api from '../utils/api';
import { acceptInvite, fetchInvite } from './guildService';

beforeEach(() => vi.clearAllMocks());

describe('invite codes in API paths', () => {
  it('asks about and accepts an invite code', async () => {
    await fetchInvite('hTKzmak1');
    await acceptInvite('my-guild');
    expect(api.get).toHaveBeenCalledWith('/invites/hTKzmak1');
    expect(api.post).toHaveBeenCalledWith('/invites/my-guild');
  });

  // /invite/..%2Fguilds%2F5%2Finvites reaches the page as "../guilds/5/invites" (security audit).
  it('never sends anything else, refusing it as an unknown invite', async () => {
    for (const code of ['../guilds/5/invites', '..', 'a?b=1', 'a b', '', 'x'.repeat(33), undefined]) {
      await expect(fetchInvite(code)).rejects.toMatchObject({ response: { status: 404 } });
      await expect(acceptInvite(code)).rejects.toMatchObject({ response: { status: 404 } });
    }
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });
});
