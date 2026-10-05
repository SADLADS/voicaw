// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const log = vi.hoisted(() => ({ entries: [] }));
vi.mock('../../voice/watchParty', async (importOriginal) => ({
  ...(await importOriginal()),
  useWatchPartyLog: () => log.entries,
}));
vi.mock('../../utils/profiles', () => ({
  useProfiles: () => {},
  displayName: (id) => ({ 7: 'alice', 8: 'bob' })[id] ?? 'someone',
}));

import WatchPartyActivity from './WatchPartyActivity';

const at = new Date(2026, 9, 6, 20, 15, 30).getTime();
const entry = (id, changes) => ({ id, at, user_id: 7, video_id: 'aaaaaaaaaaa', title: 'Me at the zoo', ...changes });

describe('WatchPartyActivity', () => {
  it('shows nothing before anything happened', () => {
    log.entries = [];
    const { container } = render(<WatchPartyActivity channelId={2} />);
    expect(container.innerHTML).toBe('');
  });

  it('folded, shows the latest; open, everything newest first, as sentences with times', () => {
    log.entries = [
      entry(1, { action: 'add' }),
      entry(2, { action: 'seek', user_id: 8, from: 5, to: 83 }),
      entry(3, { action: 'move', to: 2, title: null }),
      entry(4, { action: 'pause' }),
      entry(5, { action: 'skip', user_id: 8 }),
      entry(6, { action: 'ended', user_id: null }),
      entry(7, { action: 'something-new' }),
    ];
    render(<WatchPartyActivity channelId={2} />);
    const toggle = screen.getByRole('button', { name: /Activity \(6\)/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('Me at the zoo finished');

    fireEvent.click(toggle);
    const lines = screen.getAllByRole('listitem').map((li) => li.querySelector('.watch-party-activity-text').textContent);
    expect(lines).toEqual([
      'Me at the zoo finished',
      'bob skipped Me at the zoo',
      'alice paused Me at the zoo',
      'alice moved YouTube video to number 2 in the queue',
      'bob jumped from 0:05 to 1:23 in Me at the zoo',
      'alice added Me at the zoo',
    ]);
    expect(screen.getAllByRole('listitem')[0].querySelector('time').textContent).toMatch(/15:30/);
  });
});
