// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const botDmListeners = vi.hoisted(() => ({ list: [] }));

vi.mock('../utils/ws-client', () => ({
  setActiveChat: vi.fn(),
  onBotDmEvent: (cb) => {
    botDmListeners.list.push(cb);
    return () => { botDmListeners.list = botDmListeners.list.filter((x) => x !== cb); };
  },
}));

vi.mock('../services/botDmService', () => ({
  fetchBotDmMessages: vi.fn(),
  sendBotDmMessage: vi.fn(),
  editBotDmMessage: vi.fn(),
  deleteBotDmMessage: vi.fn(),
  markBotDmRead: vi.fn(async () => {}),
  deleteBotDm: vi.fn(async () => {}),
}));

vi.mock('./MessageList', () => ({
  MessageContent: ({ msg }) => <div>{msg.plaintext}</div>,
  default: ({ messages }) => (
    <div data-testid="message-list">
      {messages.map((m) => <div key={m.clientKey ?? m.id}>{m.plaintext} [{m.status || 'sent'}]</div>)}
    </div>
  ),
}));

import BotDm from './BotDm';
import { editorFor } from '../editor/editorRegistry';
import { ConfigContext, InteractionContext, LayoutContext } from '../contexts';
import { deleteBotDm, fetchBotDmMessages, markBotDmRead, sendBotDmMessage } from '../services/botDmService';
import { mergeProfiles } from '../utils/profiles';

const me = { id: 2, username: 'alice' };
const summary = { id: 7, bot_id: 40, bot: { id: 40, username: 'chess#0420', display_name: 'Chess Bot', bot: 1 }, unread: 1, last_timestamp: 100 };

function renderBotDm() {
  const botDmList = { botDms: [summary], clearUnread: vi.fn() };
  render(
    <ConfigContext.Provider value={{ s3Endpoint: 'https://s3.test', maxPlaintextLength: 5000 }}>
      <InteractionContext.Provider value={{ isMobile: false }}>
        <LayoutContext.Provider value={{ botDmList }}>
          <MemoryRouter initialEntries={['/dm/b/7']}>
            <Routes>
              <Route path="/dm/b/:dmId" element={<BotDm user={me} />} />
              <Route path="/dm" element={<p>dm home</p>} />
            </Routes>
          </MemoryRouter>
        </LayoutContext.Provider>
      </InteractionContext.Provider>
    </ConfigContext.Provider>
  );
  return botDmList;
}

beforeEach(() => {
  vi.clearAllMocks();
  botDmListeners.list = [];
  mergeProfiles([summary.bot]);
  fetchBotDmMessages.mockResolvedValue([{ id: 11, dm_id: 7, sender_id: 40, plaintext: "It's your move", timestamp: 100, reactions: [] }]);
});

describe('BotDm', () => {
  it("says it isn't encrypted, reads the conversation, and sends text", async () => {
    const list = renderBotDm();
    expect(await screen.findByText("It's your move [sent]")).toBeInTheDocument();
    expect(screen.getByText('Not encrypted')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent("Messages with Chess Bot aren't end-to-end encrypted");
    expect(screen.getByText('BOT')).toBeInTheDocument();
    await waitFor(() => expect(markBotDmRead).toHaveBeenCalledWith(7, 11));
    expect(list.clearUnread).toHaveBeenCalledWith(7);
    // Text only: no + menu (files, polls).
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();

    sendBotDmMessage.mockResolvedValue({ id: 12, dm_id: 7, sender_id: 2, plaintext: 'On it', timestamp: 101, reactions: [] });
    const editor = editorFor(document.getElementById('dm-input'));
    act(() => editor.setText('On it'));
    fireEvent.submit(document.getElementById('dm-chat-form'));
    await waitFor(() => expect(sendBotDmMessage).toHaveBeenCalledWith(7, 'On it', expect.any(String)));
    expect(await screen.findByText('On it [sent]')).toBeInTheDocument();
  });

  it('shows what the bot sends live, and deletes the conversation after asking', async () => {
    renderBotDm();
    await screen.findByText("It's your move [sent]");
    act(() => botDmListeners.list.forEach((cb) => cb({
      type: 'bot_dm_message_new', dmId: 7, message: { id: 13, dm_id: 7, sender_id: 40, plaintext: 'Day 2 reminder', timestamp: 102, reactions: [] },
    })));
    expect(screen.getByText('Day 2 reminder [sent]')).toBeInTheDocument();
    await waitFor(() => expect(markBotDmRead).toHaveBeenCalledWith(7, 13));

    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteBotDm).toHaveBeenCalledWith(7));
    expect(await screen.findByText('dm home')).toBeInTheDocument();
  });
});
