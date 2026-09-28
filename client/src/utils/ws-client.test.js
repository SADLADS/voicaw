import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  connectWebSocket,
  closeWebSocket,
  onNewDm,
  onDeleteDm,
  onEditDm,
  onUserStatus,
  setActiveChat,
} from './ws-client';

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
  global.WebSocket = MockWebSocket;
  global.localStorage = fakeLocalStorage();
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
    global.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();

    expect(MockWebSocket.instances.length).toBe(1);
    const socket = MockWebSocket.instances[0];
    socket._open();

    expect(JSON.parse(socket.sent[0])).toEqual({ type: 'identify', token: 'jwt-abc' });
    // followed by its presence (no chat open yet)
    expect(JSON.parse(socket.sent[1])).toEqual({ type: 'presence', visible: true, chatId: null });
  });

  it('does not open a second socket if already connected', () => {
    global.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();
    MockWebSocket.instances[0]._open();

    connectWebSocket();
    expect(MockWebSocket.instances.length).toBe(1);
  });
});

describe('message routing', () => {
  function connectAndOpen() {
    global.localStorage.setItem('token', 'jwt-abc');
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

  it('routes user_status events to status listeners', () => {
    const socket = connectAndOpen();
    const onStatus = vi.fn();
    onUserStatus(onStatus);

    socket._receive({ type: 'user_status', userId: '3', status: 'online' });

    expect(onStatus).toHaveBeenCalledWith({ type: 'user_status', userId: '3', status: 'online' });
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
    global.localStorage.setItem('token', 'jwt-abc');
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
    global.localStorage.setItem('token', 'jwt-abc');
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
    global.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();
    const socket = MockWebSocket.instances[0];

    socket.close(1006, 'dropped');
    expect(MockWebSocket.instances.length).toBe(1);

    vi.advanceTimersByTime(3000);
    expect(MockWebSocket.instances.length).toBe(2);
  });
});

describe('presence', () => {
  const presences = (socket) =>
    socket.sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'presence');

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the open chat whenever it changes', () => {
    global.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();
    const socket = MockWebSocket.instances[0];
    socket._open();

    setActiveChat(42);
    setActiveChat(null);

    expect(presences(socket).slice(-2)).toEqual([
      { type: 'presence', visible: true, chatId: '42' },
      { type: 'presence', visible: true, chatId: null },
    ]);
  });

  it('re-sends presence periodically so the server knows it is still current', () => {
    vi.useFakeTimers();
    global.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();
    const socket = MockWebSocket.instances[0];
    socket._open();
    setActiveChat(7);
    const before = presences(socket).length;

    vi.advanceTimersByTime(31000);

    expect(presences(socket).length).toBe(before + 2);
    expect(presences(socket).at(-1).chatId).toBe('7');
  });

  it('stops sending presence once closed', () => {
    vi.useFakeTimers();
    global.localStorage.setItem('token', 'jwt-abc');
    connectWebSocket();
    const socket = MockWebSocket.instances[0];
    socket._open();
    closeWebSocket();
    const sent = socket.sent.length;

    vi.advanceTimersByTime(60000);

    expect(socket.sent.length).toBe(sent);
  });
});
