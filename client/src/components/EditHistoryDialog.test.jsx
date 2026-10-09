// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import EditHistoryDialog from './EditHistoryDialog';

const user = { id: 1, username: 'alice' };
const msg = { id: 5, sender_id: 2, plaintext: 'third **now**', timestamp: 1000, edited: 1 };

describe('EditHistoryDialog', () => {
  it('lists the earlier versions oldest first, then what the message says now', async () => {
    const loadEdits = vi.fn(async () => ({
      versions: [
        { plaintext: 'first', written_at: 1000, edited: 0 },
        { plaintext: 'second ![photo.png](https://s3.test/uploads/a.bin#v=1&k=x&t=image/png&s=1)', written_at: 1100, edited: 1 },
        { plaintext: null, written_at: null, edited: 1 },
      ],
      edited_at: 1200,
    }));
    render(<EditHistoryDialog msg={msg} loadEdits={loadEdits} onClose={vi.fn()} user={user} s3Endpoint="https://s3.test" />);
    expect(screen.getByRole('dialog', { name: 'Edit history' })).toBeInTheDocument();
    expect(loadEdits).toHaveBeenCalledWith(msg);

    const items = await screen.findAllByRole('listitem');
    expect(items.map((li) => li.querySelector('strong').textContent)).toEqual(['Original', 'Edit', 'Edit', 'Now']);
    expect(items[0]).toHaveTextContent('first');
    // Attachments show as their names (a removed one is deleted), never their links.
    expect(items[1]).toHaveTextContent('second 📎 photo.png');
    expect(items[1].querySelector('img')).toBeNull();
    expect(items[2]).toHaveTextContent("This version can't be decrypted.");
    expect(items[2]).toHaveTextContent('edited before history was kept');
    expect(items[3]).toHaveTextContent('third now');
    expect(items[3]).toHaveClass('current');
  });

  it('says when nothing earlier was kept, and when loading fails', async () => {
    const { unmount } = render(
      <EditHistoryDialog msg={msg} loadEdits={async () => ({ versions: [], edited_at: null })} onClose={vi.fn()} user={user} />
    );
    expect(await screen.findByText(/edited before Voicaw kept edit history/)).toBeInTheDocument();
    unmount();
    render(<EditHistoryDialog msg={msg} loadEdits={async () => { throw new Error('nope'); }} onClose={vi.fn()} user={user} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the edit history.");
  });
});
