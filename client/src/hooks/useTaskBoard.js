import { useCallback, useEffect, useRef, useState } from 'react';
import { onConnectionState, onGuildEvent, setActiveChat } from '../utils/ws-client';
import {
  createTask,
  deleteTask,
  fetchTasks,
  moveTask,
  updateTask,
} from '../services/guildService';
import { applyPlacements, moveLocally, subtreeIds } from '../utils/taskTree';

// One list channel's tasks (flat, as the server sends them; utils/taskTree builds the tree),
// kept current by the websocket (guild_task_* events) and loaded again after a reconnect.
// Moving and completing show at once and are undone if the server refuses. Like a text
// channel, the board counts as the chat you're looking at (no assignment pushes meanwhile).
export function useTaskBoard({ channelId }) {
  const [tasks, setTasks] = useState([]);
  const [loadedChannelId, setLoadedChannelId] = useState(null);
  const [error, setError] = useState(null);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  // The board being shown, so a late response for a previous one is ignored.
  const currentChannel = useRef(channelId);

  const load = useCallback(() => {
    if (!channelId) return Promise.resolve();
    const id = channelId;
    return fetchTasks(id)
      .then((list) => {
        if (String(id) !== String(currentChannel.current)) return;
        setTasks(list);
        setLoadedChannelId(String(id));
        setError(null);
      })
      .catch((err) => {
        if (String(id) === String(currentChannel.current)) setError(err);
      });
  }, [channelId]);

  useEffect(() => {
    currentChannel.current = channelId;
    setTasks([]);
    setLoadedChannelId(null);
    setError(null);
    load();
  }, [channelId, load]);

  useEffect(() => {
    if (!channelId) return undefined;
    setActiveChat(`channel-${channelId}`);
    return () => setActiveChat(null);
  }, [channelId]);

  // After being offline, events may have been missed.
  useEffect(() => {
    let wasOnline = true;
    return onConnectionState((state) => {
      if (state === 'online' && !wasOnline) load();
      wasOnline = state === 'online';
    });
  }, [load]);

  useEffect(() => {
    if (!channelId) return undefined;
    const id = Number(channelId);
    return onGuildEvent((event) => {
      if (event.channelId !== id) return;
      switch (event.type) {
        case 'guild_task_upsert':
          setTasks((list) => (list.some((t) => t.id === event.task.id)
            ? list.map((t) => (t.id === event.task.id ? event.task : t))
            : [...list, event.task]));
          break;
        case 'guild_task_delete': {
          const gone = new Set(event.ids);
          setTasks((list) => list.filter((t) => !gone.has(t.id)));
          break;
        }
        case 'guild_tasks_move':
          setTasks((list) => applyPlacements(list, event.tasks));
          break;
        case 'guild_task_comment_new':
        case 'guild_task_comment_delete': {
          const change = event.type === 'guild_task_comment_new' ? 1 : -1;
          setTasks((list) => list.map((t) => (t.id === event.taskId ? { ...t, comment_count: Math.max(0, t.comment_count + change) } : t)));
          break;
        }
        default:
      }
    });
  }, [channelId]);

  const upsert = (task) => setTasks((list) => (list.some((t) => t.id === task.id)
    ? list.map((t) => (t.id === task.id ? task : t))
    : [...list, task]));

  const addTask = useCallback(async (fields) => {
    const task = await createTask(channelId, fields);
    upsert(task);
    return task;
  }, [channelId]);

  const editTask = useCallback(async (taskId, changes) => {
    const before = tasksRef.current.find((t) => t.id === taskId);
    // Completing shows straight away.
    if (before && changes.completed !== undefined) {
      setTasks((list) => list.map((t) => (t.id === taskId
        ? { ...t, completed_at: changes.completed ? (t.completed_at ?? Math.floor(Date.now() / 1000)) : null }
        : t)));
    }
    try {
      const task = await updateTask(taskId, changes);
      upsert(task);
      return task;
    } catch (err) {
      if (before) setTasks((list) => list.map((t) => (t.id === taskId ? before : t)));
      throw err;
    }
  }, []);

  const placeTask = useCallback(async (taskId, { parentId, beforeId }) => {
    const before = tasksRef.current;
    setTasks((list) => moveLocally(list, taskId, parentId, beforeId));
    try {
      const { tasks: placed } = await moveTask(taskId, { parentId, beforeId });
      setTasks((list) => applyPlacements(list, placed));
    } catch (err) {
      setTasks(before);
      throw err;
    }
  }, []);

  const removeTask = useCallback(async (taskId) => {
    const { ids } = await deleteTask(taskId);
    const gone = new Set(ids ?? subtreeIds(tasksRef.current, taskId));
    setTasks((list) => list.filter((t) => !gone.has(t.id)));
  }, []);

  return {
    tasks,
    loaded: loadedChannelId === String(channelId),
    error,
    reload: load,
    addTask,
    editTask,
    placeTask,
    removeTask,
  };
}
