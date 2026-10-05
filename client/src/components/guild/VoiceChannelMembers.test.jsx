// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../voice/voiceClient', async (importOriginal) => ({
  ...(await importOriginal()),
  setUserVolume: vi.fn(),
}));

import VoiceChannelMembers from './VoiceChannelMembers';
import { mergeProfiles } from '../../utils/profiles';

describe('VoiceChannelMembers', () => {
  it('puts an ear on bots that can hear the channel, and only on them', () => {
    mergeProfiles([
      { id: 1, username: 'alice' },
      { id: 2, username: 'radio#0001', display_name: 'Radio', bot: 1 },
      { id: 3, username: 'scribe#0002', display_name: 'Scribe', bot: 1 },
    ]);
    render(<VoiceChannelMembers speaking={new Set()} members={[
      { user_id: 1, username: 'alice', listening: true },
      { user_id: 2, username: 'radio#0001', listening: false },
      { user_id: 3, username: 'scribe#0002', listening: true },
    ]} />);
    const ears = screen.getAllByLabelText('This bot can hear the channel');
    expect(ears).toHaveLength(1);
    expect(ears[0].closest('li')).toHaveTextContent('Scribe');
  });
});
