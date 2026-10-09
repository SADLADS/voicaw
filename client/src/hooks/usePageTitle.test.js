import { beforeEach, describe, expect, it } from 'vitest';
import { pageTitle, titleText } from './usePageTitle';
import { clearProfiles, mergeProfiles } from '../utils/profiles';

const data = {
  me: { id: 1 },
  guilds: [{ id: 7, name: 'Book club' }],
  layouts: { 7: { channels: [{ id: 99, name: 'general' }], threads: [{ id: 120, name: 'chapter-3' }] } },
  groups: [{ id: 3, name: 'Climbers', members: [] }, { id: 4, name: '', members: [{ id: 1 }, { id: 2, username: 'bob' }] }],
  botDms: [{ id: 5, bot_id: 50 }],
};
const web = (path) => titleText(pageTitle(path, data), false);
const desk = (path) => titleText(pageTitle(path, data), true);

describe('page titles', () => {
  beforeEach(() => {
    clearProfiles();
    mergeProfiles([{ id: 2, username: 'bob', display_name: 'Bob' }, { id: 50, username: 'slotto', bot: true }]);
  });

  it('web: Discord-style, with who and where', () => {
    expect(web('/dm/2')).toBe('Voicaw | @Bob');
    expect(web('/dm/b/5')).toBe('Voicaw | @slotto');
    expect(web('/dm/g/3')).toBe('Voicaw | Climbers');
    expect(web('/dm/g/4')).toBe('Voicaw | Bob');
    expect(web('/dm/friends')).toBe('Voicaw | Friends');
    expect(web('/dm/notes')).toBe('Voicaw | Notes');
    expect(web('/settings/privacy')).toBe('Voicaw | Settings');
    expect(web('/guild/7/99')).toBe('Voicaw | #general | Book club');
    expect(web('/guild/7/120')).toBe('Voicaw | #chapter-3 | Book club');
    expect(web('/guild/7')).toBe('Voicaw | Book club');
  });

  it('web: what is not known yet is left out', () => {
    expect(web('/dm/404')).toBe('Voicaw | Direct Messages');
    expect(web('/dm/g/404')).toBe('Voicaw | Direct Messages');
    expect(web('/guild/8/99')).toBe('Voicaw');
    expect(web('/invite/abc')).toBe('Voicaw');
  });

  it('desktop: only the area, never who a chat is with', () => {
    expect(desk('/dm/2')).toBe('Direct Messages');
    expect(desk('/dm/g/3')).toBe('Direct Messages');
    expect(desk('/dm/b/5')).toBe('Direct Messages');
    expect(desk('/dm/friends')).toBe('Friends');
    expect(desk('/dm/notes')).toBe('Notes');
    expect(desk('/settings')).toBe('Settings');
    expect(desk('/guild/7/99')).toBe('Book club');
    expect(desk('/guild/8/99')).toBe('Voicaw');
  });
});
