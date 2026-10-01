// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const guildListeners = vi.hoisted(() => ({ list: [] }));

vi.mock('../../utils/ws-client', () => ({
  setActiveChat: vi.fn(),
  onConnectionState: () => () => {},
  onGuildEvent: (cb) => {
    guildListeners.list.push(cb);
    return () => { guildListeners.list = guildListeners.list.filter((x) => x !== cb); };
  },
}));

vi.mock('../../services/guildService', () => ({
  fetchTasks: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  moveTask: vi.fn(),
  deleteTask: vi.fn(),
  fetchTaskComments: vi.fn(async () => []),
  addTaskComment: vi.fn(),
  editTaskComment: vi.fn(),
  deleteTaskComment: vi.fn(),
}));

// The markdown renderer needs the emoji index; plain text is enough here.
vi.mock('../MessageList', () => ({
  MessageContent: ({ msg }) => <div data-testid="rich">{msg.plaintext}</div>,
}));

import ListChannelView from './ListChannelView';
import { ConfigContext } from '../../contexts';
import { PERMISSIONS } from '../../utils/permissions';
import { setActiveChat } from '../../utils/ws-client';
import {
  fetchTasks, createTask, updateTask, fetchTaskComments, addTaskComment,
} from '../../services/guildService';

const me = { id: 1, username: 'me' };
const guild = { id: 5, name: 'G', owner: 1, my_role_ids: [], roles: [] };
const all = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.EDIT_TASKS | PERMISSIONS.SEND_MESSAGES;
const board = (permissions = all) => ({ id: 30, guild_id: 5, name: 'roadmap', type: 'list', my_permissions: permissions });
const people = [{ id: 1, username: 'me' }, { id: 2, username: 'alice' }];

const task = (id, fields = {}) => ({
  id, channel_id: 30, parent_id: null, position: id, title: `Task ${id}`, description: null, due_date: null,
  completed_at: null, completed_by: null, created_by: 1, created_at: 1000, updated_at: 1000,
  assignees: [], comment_count: 0, ...fields,
});

let location;
function Where() {
  location = useLocation();
  return null;
}

function renderBoard({ channel = board(), url = '/guild/5/30' } = {}) {
  return render(
    <ConfigContext.Provider value={{ s3Endpoint: '' }}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/guild/:guildId/:channelId"
            element={(
              <>
                <ListChannelView guild={guild} channel={channel} user={me} people={people} reactionNames={{}} mentionRoles={{}} nameColors={{}} isMobile={false} />
                <Where />
              </>
            )}
          />
        </Routes>
      </MemoryRouter>
    </ConfigContext.Provider>
  );
}

const emit = (event) => act(() => guildListeners.list.forEach((cb) => cb({ guildId: 5, channelId: 30, ...event })));

beforeEach(() => {
  vi.clearAllMocks();
  guildListeners.list = [];
  localStorage.clear();
});

describe('ListChannelView', () => {
  it('shows the tasks as a tree, with subtask progress', async () => {
    fetchTasks.mockResolvedValue([
      task(1), task(2, { parent_id: 1, completed_at: 5 }), task(3, { parent_id: 1 }), task(4),
    ]);
    renderBoard();
    expect(await screen.findByText('Task 1')).toBeTruthy();
    const titles = screen.getAllByText(/^Task \d$/).map((el) => el.textContent);
    expect(titles).toEqual(['Task 1', 'Task 2', 'Task 3', 'Task 4']);
    expect(screen.getByText('1 of 4 done')).toBeTruthy();
    expect(screen.getByTitle('Subtasks done').textContent).toContain('1/2');
    expect(setActiveChat).toHaveBeenCalledWith('channel-30');

    // Collapsing hides the subtasks, and is remembered.
    fireEvent.click(screen.getByLabelText('Hide subtasks of Task 1'));
    expect(screen.queryByText('Task 2')).toBeNull();
    expect(JSON.parse(localStorage.getItem('taskCollapsed:30'))).toEqual([1]);
  });

  it('adds tasks and completes them', async () => {
    fetchTasks.mockResolvedValue([task(1)]);
    createTask.mockResolvedValue(task(9, { title: 'New one' }));
    updateTask.mockResolvedValue(task(1, { completed_at: 50 }));
    renderBoard();
    await screen.findByText('Task 1');

    fireEvent.change(screen.getByLabelText('New task title'), { target: { value: ' New one ' } });
    fireEvent.submit(screen.getByLabelText('New task title').closest('form'));
    await screen.findByText('New one');
    expect(createTask).toHaveBeenCalledWith(30, { title: 'New one' });

    fireEvent.click(screen.getByLabelText('Mark "Task 1" done'));
    expect(updateTask).toHaveBeenCalledWith(1, { completed: true });
    await waitFor(() => expect(screen.getByLabelText('Mark "Task 1" not done')).toBeTruthy());
  });

  it('filters to open tasks and to what is assigned to you', async () => {
    fetchTasks.mockResolvedValue([task(1, { completed_at: 5 }), task(2, { assignees: [1] }), task(3)]);
    renderBoard();
    await screen.findByText('Task 1');
    fireEvent.click(screen.getByRole('tab', { name: 'Open' }));
    expect(screen.queryByText('Task 1')).toBeNull();
    expect(screen.getByText('Task 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Assigned to me' }));
    expect(screen.getByText('Task 2')).toBeTruthy();
    expect(screen.queryByText('Task 3')).toBeNull();
  });

  it('is read-only without Edit Tasks', async () => {
    fetchTasks.mockResolvedValue([task(1)]);
    renderBoard({ channel: board(PERMISSIONS.VIEW_CHANNEL) });
    await screen.findByText('Task 1');
    expect(screen.queryByLabelText('New task title')).toBeNull();
    expect(screen.getByLabelText('Mark "Task 1" done').disabled).toBe(true);
    expect(screen.queryByLabelText('Add a subtask to Task 1')).toBeNull();
  });

  it('applies live changes from others', async () => {
    fetchTasks.mockResolvedValue([task(1), task(2)]);
    renderBoard();
    await screen.findByText('Task 1');
    emit({ type: 'guild_task_upsert', task: task(3, { title: 'From Alice' }) });
    expect(screen.getByText('From Alice')).toBeTruthy();
    emit({ type: 'guild_tasks_move', tasks: [{ id: 2, parent_id: null, position: 0 }, { id: 1, parent_id: null, position: 1 }] });
    expect(screen.getAllByText(/^Task \d$/).map((el) => el.textContent)).toEqual(['Task 2', 'Task 1']);
    emit({ type: 'guild_task_delete', ids: [1] });
    expect(screen.queryByText('Task 1')).toBeNull();
    // Another board's events don't count.
    emit({ type: 'guild_task_upsert', channelId: 99, task: task(7, { title: 'Elsewhere' }) });
    expect(screen.queryByText('Elsewhere')).toBeNull();
  });

  it('opens a task from ?task=, with its details and comments', async () => {
    fetchTasks.mockResolvedValue([task(1, { description: 'The **details**', assignees: [2], due_date: '2026-10-05' }), task(2, { parent_id: 1, title: 'Sub' })]);
    fetchTaskComments.mockResolvedValue([
      { id: 11, task_id: 1, sender_id: 2, sender_username: 'alice', content: 'On it', timestamp: 2000, edited_at: null },
    ]);
    addTaskComment.mockResolvedValue({ id: 12, task_id: 1, sender_id: 1, sender_username: 'me', content: 'Thanks', timestamp: 2001 });
    renderBoard({ url: '/guild/5/30?task=1' });
    const panel = await screen.findByRole('complementary', { name: 'Task: Task 1' });
    expect(within(panel).getByText('The **details**')).toBeTruthy();
    expect(within(panel).getByText('alice')).toBeTruthy();
    expect(await within(panel).findByText('On it')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Sub' })).toBeTruthy();

    fireEvent.change(within(panel).getByLabelText('Write a comment'), { target: { value: 'Thanks' } });
    fireEvent.keyDown(within(panel).getByLabelText('Write a comment'), { key: 'Enter' });
    expect(await within(panel).findByText('Thanks')).toBeTruthy();
    expect(addTaskComment).toHaveBeenCalledWith(1, 'Thanks');

    // A subtask opens in its place; closing drops ?task.
    fireEvent.click(within(panel).getByRole('button', { name: 'Sub' }));
    expect(location.search).toBe('?task=2');
    fireEvent.click(screen.getByLabelText('Close task'));
    expect(location.search).toBe('');
  });

  it('assigns people from the picker', async () => {
    fetchTasks.mockResolvedValue([task(1)]);
    updateTask.mockImplementation(async (id, changes) => task(1, { assignees: changes.assigneeIds }));
    renderBoard({ url: '/guild/5/30?task=1' });
    const panel = await screen.findByRole('complementary', { name: 'Task: Task 1' });
    fireEvent.click(within(panel).getByRole('button', { name: /Assign$/ }));
    fireEvent.click(within(panel).getByLabelText(/alice/));
    expect(updateTask).toHaveBeenCalledWith(1, { assigneeIds: [2] });
    await within(panel).findByLabelText('Unassign alice');
    fireEvent.click(within(panel).getByRole('button', { name: 'Assign me' }));
    await waitFor(() => expect(updateTask).toHaveBeenLastCalledWith(1, { assigneeIds: [2, 1] }));
  });
});
