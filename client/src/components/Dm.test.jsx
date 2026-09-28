// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const dmListeners = vi.hoisted(() => ({ newDm: [], deleteDm: [], editDm: [] }));

vi.mock('../utils/ws-client', () => ({
  onNewDm: (cb) => {
    dmListeners.newDm.push(cb);
    return () => { dmListeners.newDm = dmListeners.newDm.filter((x) => x !== cb); };
  },
  onDeleteDm: (cb) => {
    dmListeners.deleteDm.push(cb);
    return () => { dmListeners.deleteDm = dmListeners.deleteDm.filter((x) => x !== cb); };
  },
  onEditDm: (cb) => {
    dmListeners.editDm.push(cb);
    return () => { dmListeners.editDm = dmListeners.editDm.filter((x) => x !== cb); };
  },
}));

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('../services/dmService', () => ({
  fetchMessagesForUser: vi.fn(),
  sendMessageToUser: vi.fn(),
  markMessagesRead: vi.fn(),
}));

vi.mock('../services/encryptionService', () => ({
  encryptMessage: vi.fn(async (text) => `enc(${text})`),
  decryptMessage: vi.fn(async (content) => `dec(${content})`),
  deriveSharedKey: vi.fn(async () => 'shared-key'),
  decryptMessagesBatch: vi.fn(async (messages) =>
    messages.map((m) => ({ ...m, plaintext: m.plaintext ?? `dec:${m.content}` }))
  ),
}));

vi.mock('../services/keyStore', () => ({
  loadPrivateKey: vi.fn(async () => 'fake-private-key'),
}));

// Dm renders real Virtuoso-backed MessageList; stub it so these tests exercise
// Dm's own state machine (fetch/send/receive) rather than virtualization.
vi.mock('./MessageList', () => ({
  default: ({ messages }) => (
    <div data-testid="message-list">
      {messages.map((m) => (
        <div key={m.id}>{m.plaintext} [{m.status || 'sent'}]</div>
      ))}
    </div>
  ),
}));

import Dm from './Dm';
import { ConfigContext, InteractionContext } from '../App';
import { LayoutContext } from './Layout';
import { fetchMessagesForUser, sendMessageToUser, markMessagesRead } from '../services/dmService';
import { deriveSharedKey } from '../services/encryptionService';

const currentUser = { id: 1, username: 'me' };
const chatUserFull = { id: 2, username: 'bob', public_key: 'bob-pub-key' };
const chatUserNoKey = { id: 3, username: 'nokey' };

function renderDm({ path, users, user = currentUser, layoutOverrides = {} } = {}) {
  return render(
    <ConfigContext.Provider value={{ s3Endpoint: 'https://s3.test', maxPlaintextLength: 5000 }}>
      <InteractionContext.Provider value={{ isMobile: false }}>
        <LayoutContext.Provider
          value={{ unreadDms: {}, users, errorUsers: null, fetchUnreadMessages: vi.fn(), ...layoutOverrides }}
        >
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/dm/:id?" element={<Dm user={user} />} />
            </Routes>
          </MemoryRouter>
        </LayoutContext.Provider>
      </InteractionContext.Provider>
    </ConfigContext.Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dmListeners.newDm = [];
  dmListeners.deleteDm = [];
  dmListeners.editDm = [];
  localStorage.clear();
  fetchMessagesForUser.mockResolvedValue([]);
  deriveSharedKey.mockResolvedValue('shared-key');
});

describe('Dm', () => {
  it('shows the empty state when there is no active conversation', () => {
    renderDm({ path: '/dm', users: [] });

    expect(screen.getByText('No recent conversations found.')).toBeInTheDocument();
  });

  it("shows 'no messages yet' when the chat user has no public key (no shared key derivable)", async () => {
    renderDm({ path: '/dm/3', users: [chatUserNoKey] });

    expect(await screen.findByText('No messages yet. Start the conversation!')).toBeInTheDocument();
    expect(screen.getByText('nokey')).toBeInTheDocument();
    expect(fetchMessagesForUser).not.toHaveBeenCalled();
  });

  it('fetches and displays decrypted messages for a valid conversation', async () => {
    fetchMessagesForUser.mockResolvedValue([
      { id: 10, sender_id: 2, recipient_id: 1, content: 'ENC1', timestamp: 1000 },
      { id: 11, sender_id: 1, recipient_id: 2, content: 'ENC2', timestamp: 1001 },
    ]);

    renderDm({ path: '/dm/2', users: [chatUserFull] });

    expect(await screen.findByText('dec:ENC1 [sent]')).toBeInTheDocument();
    expect(screen.getByText('dec:ENC2 [sent]')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('optimistically shows a pending message then marks it sent once the server responds', async () => {
    let resolveSend;
    sendMessageToUser.mockReturnValue(
      new Promise((resolve) => { resolveSend = resolve; })
    );

    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('No messages yet. Start the conversation!');

    const textarea = document.getElementById('dm-input');
    fireEvent.change(textarea, { target: { value: 'hello bob' } });
    fireEvent.submit(document.getElementById('dm-chat-form'));

    expect(await screen.findByText('hello bob [pending]')).toBeInTheDocument();

    await act(async () => {
      resolveSend({ id: 99, sender_id: 1, recipient_id: 2, content: 'ENCX', timestamp: 2000 });
    });

    expect(await screen.findByText('hello bob [sent]')).toBeInTheDocument();
    expect(screen.queryByText('hello bob [pending]')).not.toBeInTheDocument();
  });

  it('appends an incoming new_dm websocket event for the active conversation', async () => {
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('No messages yet. Start the conversation!');
    await waitFor(() => expect(dmListeners.newDm.length).toBeGreaterThan(0));

    await act(async () => {
      dmListeners.newDm[dmListeners.newDm.length - 1]({
        id: 55,
        sender_id: 2,
        recipient_id: 1,
        plaintext: 'incoming hello',
        timestamp: 3000,
      });
    });

    expect(await screen.findByText('incoming hello [sent]')).toBeInTheDocument();
  });

  it('marks messages read for the active conversation', async () => {
    renderDm({ path: '/dm/2', users: [chatUserFull] });

    await waitFor(() => expect(markMessagesRead).toHaveBeenCalledWith(2));
  });
});
