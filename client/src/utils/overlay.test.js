import { describe, it, expect } from 'vitest';
import { overlayVoiceState } from './overlay';

const IDLE = { status: 'idle', participants: [], speaking: [], muted: [], identity: null, selfMute: false, selfDeaf: false };
const name = (id, fallback) => ({ 1: 'Alice', 2: 'Bob', 3: 'Carol' }[id] ?? fallback);
const avatar = (id) => (id === '2' ? 'https://s3.example/profile-pics/2/a.webp' : null);

describe('overlayVoiceState', () => {
  it('is null out of voice', () => {
    expect(overlayVoiceState(IDLE, { title: '', name, avatar })).toBeNull();
  });

  it("lists everyone in a call, you first, with who's talking and muted", () => {
    const voice = {
      ...IDLE,
      status: 'connected',
      callId: 'c1',
      identity: '1',
      participants: ['1', '2', '3'],
      speaking: ['2'],
      muted: ['3'],
      selfMute: true,
    };
    expect(overlayVoiceState(voice, { title: 'Call with Bob', name, avatar })).toEqual({
      title: 'Call with Bob',
      status: 'connected',
      selfMute: true,
      selfDeaf: false,
      members: [
        { id: '1', name: 'Alice', avatar: null, speaking: false, muted: true, deafened: false, self: true },
        { id: '2', name: 'Bob', avatar: 'https://s3.example/profile-pics/2/a.webp', speaking: true, muted: false, deafened: false, self: false },
        { id: '3', name: 'Carol', avatar: null, speaking: false, muted: true, deafened: false, self: false },
      ],
    });
  });

  it("takes deafened from a guild channel's voice states, and its list while connecting", () => {
    const channelMembers = [
      { user_id: 1, username: 'alice', self_mute: false, self_deaf: false },
      { user_id: 4, username: 'dave', self_mute: true, self_deaf: true },
    ];
    const connecting = { ...IDLE, status: 'connecting', guildId: 9, channelId: 10, speaking: ['4'] };
    const state = overlayVoiceState(connecting, { title: 'General / Guild', channelMembers, name, avatar });
    expect(state.members.map((m) => [m.id, m.name, m.speaking, m.muted, m.deafened])).toEqual([
      ['1', 'Alice', false, false, false],
      ['4', 'dave', false, true, true],
    ]);

    const connected = { ...connecting, status: 'connected', identity: '1', participants: ['1', '4'], selfDeaf: true };
    const after = overlayVoiceState(connected, { title: 'General / Guild', channelMembers, name, avatar });
    expect(after.members[0]).toMatchObject({ self: true, muted: true, deafened: true });
    expect(after.members[1]).toMatchObject({ speaking: true, muted: true, deafened: true });
  });
});
