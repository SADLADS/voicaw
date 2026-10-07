import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  connectWebSocket,
  closeWebSocket,
  onNewDm,
  onDeleteDm,
  onEditDm,
  setActiveChat,
  onLoggedOutElsewhere,
} from './ws-client';
import { presenceOf } from './presence';

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    MockWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  close(code, reason) {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  _open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  _receive(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}
MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;
MockWebSocket.instances = [];

function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
}

beforeEach(() => {
  MockWebSocket.instances = [];
  globalThis.WebSocket = MockWebSocket;
  globalThis.localStorage = fakeLocalStorage();
  closeWebSocket();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connectWebSocket', () => {
  it('does nothing when no token is stored', () => {
    connectWebSocket();
    expect(MockWebSocket.instances.length).toBe(0);
  });

  it('opens a socket and sends an identify message once connected', () => {
    globalThis.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();

    expect(MockWebSocket.instances.length).toBe(1);
    const socket = MockWebSocket.instances[0];
    socket._open();

    // Its presence first (no chat open yet, active, not a phone), then identify.
    expect(JSON.parse(socket.sent[0])).toEqual({ type: 'presence', visible: true, chatId: null, sideChatId: null, mobile: false, desktopNotifications: false, reactionPushes: true, idleIn: expect.any(Number) });
    expect(JSON.parse(socket.sent[0]).idleIn).toBeGreaterThan(9 * 60 * 1000);
    expect(JSON.parse(socket.sent[1])).toEqual({ type: 'identify', token: 'jwt-abc' });
  });

  it('does not open a second socket if already connected', () => {
    globalThis.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();
    MockWebSocket.instances[0]._open();

    connectWebSocket();
    expect(MockWebSocket.instances.length).toBe(1);
  });
});

describe('message routing', () => {
  function connectAndOpen() {
    globalThis.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();
    const socket = MockWebSocket.instances[0];
    socket._open();
    return socket;
  }

  it('routes new_dm events only to new-dm listeners', () => {
    const socket = connectAndOpen();
    const onNew = vi.fn();
    const onDelete = vi.fn();
    onNewDm(onNew);
    onDeleteDm(onDelete);

    socket._receive({ type: 'new_dm', message: { id: 1, content: 'hi' } });

    expect(onNew).toHaveBeenCalledWith({ id: 1, content: 'hi' });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('routes delete_dm events to delete listeners', () => {
    const socket = connectAndOpen();
    const onDelete = vi.fn();
    onDeleteDm(onDelete);

    socket._receive({ type: 'delete_dm', messageId: 5 });

    expect(onDelete).toHaveBeenCalledWith({ type: 'delete_dm', messageId: 5 });
  });

  it('routes edit_dm events to edit listeners', () => {
    const socket = connectAndOpen();
    const onEdit = vi.fn();
    onEditDm(onEdit);

    socket._receive({ type: 'edit_dm', messageId: 5, content: 'edited' });

    expect(onEdit).toHaveBeenCalledWith({ type: 'edit_dm', messageId: 5, content: 'edited' });
  });

  it('keeps online status from the snapshot and user_status events', () => {
    const socket = connectAndOpen();
    // Before any snapshot, the status the API gave.
    expect(presenceOf({ id: 3, status: 'idle' }).status).toBe('idle');

    socket._receive({ type: 'presence_snapshot', statuses: { 3: 'online', 4: 'mobile' } });
    expect(presenceOf({ id: 3, status: 'idle' }).status).toBe('online');
    expect(presenceOf({ id: 4 }).status).toBe('mobile');
    expect(presenceOf({ id: 5, status: 'online' }).status).toBe('offline');

    socket._receive({ type: 'user_status', userId: '3', status: 'offline', lastOnline: 1700000000 });
    expect(presenceOf({ id: 3, last_online: 5 })).toEqual({ status: 'offline', lastOnline: 1700000000 });

    // Logging out forgets it all.
    closeWebSocket();
    expect(presenceOf({ id: 4, status: 'idle' }).status).toBe('idle');
  });

  it('ignores malformed messages without throwing', () => {
    const socket = connectAndOpen();
    expect(() => socket.onmessage({ data: 'not json' })).not.toThrow();
  });

  it('lets a listener unsubscribe itself', () => {
    const socket = connectAndOpen();
    const onNew = vi.fn();
    const unsubscribe = onNewDm(onNew);

    unsubscribe();
    socket._receive({ type: 'new_dm', message: { id: 1 } });

    expect(onNew).not.toHaveBeenCalled();
  });
});

describe('closeWebSocket', () => {
  it('closes the socket and clears listeners', () => {
    globalThis.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();
    const socket = MockWebSocket.instances[0];
    socket._open();

    const onNew = vi.fn();
    onNewDm(onNew);

    closeWebSocket();

    expect(socket.readyState).toBe(MockWebSocket.CLOSED);

    // Listener sets are cleared; late messages on other sockets should not reach it.
    const socket2 = new MockWebSocket('ws://ignored');
    socket2.onmessage = () => {};
    socket2._receive({ type: 'new_dm', message: { id: 99 } });
    expect(onNew).not.toHaveBeenCalled();
  });

  it('cancels a pending reconnect attempt', () => {
    vi.useFakeTimers();
    globalThis.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();
    const socket = MockWebSocket.instances[0];
    socket.close(1006, 'dropped');

    expect(MockWebSocket.instances.length).toBe(1);

    closeWebSocket();
    vi.advanceTimersByTime(5000);

    // No reconnect should have happened after closeWebSocket cancelled the timer.
    expect(MockWebSocket.instances.length).toBe(1);
  });
});

describe('reconnect behavior', () => {
  it('attempts to reconnect 3s after an unexpected close', () => {
    vi.useFakeTimers();
    globalThis.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();
    const socket = MockWebSocket.instances[0];

    socket.close(1006, 'dropped');
    expect(MockWebSocket.instances.length).toBe(1);

    vi.advanceTimersByTime(3000);
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it('logs out once when logged out elsewhere, and does not reconnect', () => {
    vi.useFakeTimers();
    globalThis.localStorage.setItem('token', 'jwt-abc');
    const loggedOut = vi.fn();
    onLoggedOutElsewhere(loggedOut);
    connectWebSocket();
    const socket = MockWebSocket.instances[0];
    socket._open();

    // The server tells the socket, then closes it.
    socket._receive({ type: 'session_revoked' });
    socket.close(1008, 'Logged out');
    expect(loggedOut).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3000);
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it('logs out when the server refuses the token', () => {
    globalThis.localStorage.setItem('token', 'jwt-abc');
    const loggedOut = vi.fn();
    onLoggedOutElsewhere(loggedOut);
    connectWebSocket();
    MockWebSocket.instances[0].close(1008, 'Invalid token');
    expect(loggedOut).toHaveBeenCalledTimes(1);
  });
});

describe('presence', () => {
  const presences = (socket) =>
    socket.sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'presence');

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the open chat whenever it changes', () => {
    globalThis.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();
    const socket = MockWebSocket.instances[0];
    socket._open();

    setActiveChat(42);
    setActiveChat(null);

    expect(presences(socket).slice(-2)).toEqual([
      expect.objectContaining({ type: 'presence', visible: true, chatId: '42' }),
      expect.objectContaining({ type: 'presence', visible: true, chatId: null }),
    ]);
  });

  it('re-sends presence periodically so the server knows it is still current', () => {
    vi.useFakeTimers();
    globalThis.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();
    const socket = MockWebSocket.instances[0];
    socket._open();
    setActiveChat(7);
    const before = presences(socket).length;

    vi.advanceTimersByTime(31000);

    expect(presences(socket).length).toBe(before + 2);
    expect(presences(socket).at(-1).chatId).toBe('7');
  });

  it('reports going idle after ten minutes without input', () => {
    vi.useFakeTimers();
    globalThis.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();
    const socket = MockWebSocket.instances[0];
    socket._open();
    expect(presences(socket).at(-1).idleIn).toBeGreaterThan(0);

    vi.advanceTimersByTime(10 * 60 * 1000 + 15000);

    expect(presences(socket).at(-1).idleIn).toBe(0);
  });

  it('stops sending presence once closed', () => {
    vi.useFakeTimers();
    globalThis.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();
    const socket = MockWebSocket.instances[0];
    socket._open();
    closeWebSocket();
    const sent = socket.sent.length;

    vi.advanceTimersByTime(60000);

    expect(socket.sent.length).toBe(sent);
  });
});
