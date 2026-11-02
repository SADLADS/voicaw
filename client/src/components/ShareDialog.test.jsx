// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const destinations = [
  { key: 'notes', kind: 'notes', name: 'Notes', path: '/dm/notes' },
  { key: 'u-2', kind: 'dm', person: { id: 2 }, name: 'Bob', path: '/dm/2' },
  { key: 'u-3', kind: 'dm', person: { id: 3 }, name: 'Cat', path: '/dm/3' },
  { key: 'c-10', kind: 'channel', channel: { id: 10, type: 'text' }, name: 'general', guildName: 'Club', path: '/guild/1/10' },
];

vi.mock('../hooks/useChatDestinations', async (importOriginal) => ({
  ...(await importOriginal()),
  useChatDestinations: () => destinations,
}));
vi.mock('./Avatar', () => ({ default: () => null }));
vi.mock('./group/GroupPicture', () => ({ default: () => null }));
vi.mock('./guild/ChannelIcon', () => ({ default: () => null }));
vi.mock('../utils/android', () => ({ sharedFileSrc: (f) => `https://localhost/_capacitor_content_/${f.name}`, showAndroidToast: vi.fn() }));
vi.mock('../services/chatSend', () => ({ sendToChat: vi.fn() }));
vi.mock('../services/shareService', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchRecentChats: vi.fn(async () => [{ kind: 'channel', id: 10, at: 50 }]),
  uploadSharedFiles: vi.fn(async () => '![a.jpg](https://s3/uploads/x.bin#k)'),
}));

const { default: ShareDialog } = await import('./ShareDialog');
const { sendToChat } = await import('../services/chatSend');
const { uploadSharedFiles } = await import('../services/shareService');
const { showAndroidToast } = await import('../utils/android');

const user = { id: 1 };
const share = { files: [{ uri: 'content://media/1', name: 'a.jpg', type: 'image/jpeg', size: 1000 }], text: '', skipped: 0 };

function open(props = {}) {
  const onClose = vi.fn();
  render(<MemoryRouter><ShareDialog user={user} share={share} onClose={onClose} {...props} /></MemoryRouter>);
  return onClose;
}

const rows = () => screen.getAllByRole('listitem').map((li) => li.textContent);
const pick = (name) => fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(name) }));

describe('ShareDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists where you last sent first, and searches', async () => {
    open();
    await waitFor(() => expect(rows()[0]).toMatch(/^general/));
    expect(rows().slice(1).map((r) => r.replace('Not encrypted', ''))).toEqual(['Notes', 'Bob', 'Cat']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'clu' } });
    expect(rows()).toHaveLength(1);
  });

  it('uploads once, sends to every chat picked, and retries only the ones that failed', async () => {
    sendToChat.mockImplementation(async (me, d) => {
      if (d.key === 'u-3') throw Object.assign(new Error('x'), { response: { data: { error: 'blocked' } } });
      return { id: 1 };
    });
    const onClose = open();
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a message' }), { target: { value: ' look ' } });
    pick('Bob');
    pick('Cat');
    fireEvent.click(screen.getByRole('button', { name: 'Send to 2 chats' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't send to Cat: blocked");
    expect(uploadSharedFiles).toHaveBeenCalledTimes(1);
    const text = 'look\n![a.jpg](https://s3/uploads/x.bin#k)';
    expect(sendToChat).toHaveBeenCalledWith(user, destinations[1], text, { nonce: expect.any(String) });
    const catNonce = sendToChat.mock.calls.find(([, d]) => d.key === 'u-3')[3].nonce;
    expect(onClose).not.toHaveBeenCalled();

    sendToChat.mockClear();
    sendToChat.mockResolvedValue({ id: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Send to 1 chat' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(uploadSharedFiles).toHaveBeenCalledTimes(1);
    expect(sendToChat).toHaveBeenCalledTimes(1);
    expect(sendToChat).toHaveBeenCalledWith(user, destinations[2], text, { nonce: catNonce });
    expect(showAndroidToast).toHaveBeenCalledWith('Sent to 2 chats.');
  });

  it('won\'t send a file over the limit', async () => {
    open({ share: { ...share, files: [{ ...share.files[0], size: 10 * 1024 ** 3 }] } });
    pick('Bob');
    expect(screen.getByRole('alert')).toHaveTextContent('a.jpg is over the');
    expect(screen.getByRole('button', { name: 'Send to 1 chat' })).toBeDisabled();
  });

  it('shares text alone', async () => {
    sendToChat.mockResolvedValue({ id: 3 });
    const onClose = open({ share: { files: [], text: 'https://example.com', skipped: 1 } });
    expect(screen.getByText("1 file couldn't be shared.")).toBeInTheDocument();
    pick('Notes');
    fireEvent.click(screen.getByRole('button', { name: 'Send to 1 chat' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(uploadSharedFiles).not.toHaveBeenCalled();
    expect(sendToChat).toHaveBeenCalledWith(user, destinations[0], 'https://example.com', { nonce: expect.any(String) });
  });
});
