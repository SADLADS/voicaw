import { useCallback, useEffect, useRef, useState } from 'react';
import { desktop } from '../utils/desktop';

// How long the download popup stays after the last file finished, unless the pointer or focus
// is on it.
export const DOWNLOAD_POPUP_MS = 8000;
// The newest files the popup lists.
const SHOWN = 3;

// The desktop app's finished downloads (electron/downloads.js), newest first, for the popup:
// [{ id, name, folder, error }]. `hold(true)` keeps them up (while hovered), `hold(false)`
// lets them go after DOWNLOAD_POPUP_MS again. Empty in a browser, which shows its own.
export function useDesktopDownloads(bridge = desktop) {
  const [items, setItems] = useState([]);
  const held = useRef(false);
  const timer = useRef(null);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    if (!held.current) timer.current = setTimeout(() => setItems([]), DOWNLOAD_POPUP_MS);
  }, []);

  useEffect(() => {
    if (!bridge?.onDownload) return undefined;
    const stop = bridge.onDownload((download) => {
      if (!download || download.id == null) return;
      setItems((list) => [{ ...download, error: null }, ...list.filter((item) => item.id !== download.id)].slice(0, SHOWN));
      schedule();
    });
    return () => {
      stop();
      clearTimeout(timer.current);
    };
  }, [bridge, schedule]);

  const forget = useCallback((id) => setItems((list) => list.filter((item) => item.id !== id)), []);
  const fail = useCallback((id, error) => setItems((list) => list.map((item) => (item.id === id ? { ...item, error } : item))), []);

  const hold = useCallback((on) => {
    held.current = on;
    schedule();
  }, [schedule]);

  const open = useCallback(async (id) => {
    try {
      const why = await bridge.downloads.open(id);
      if (why) fail(id, why === 'missing' ? 'missing' : 'noApp');
      else forget(id);
    } catch {
      fail(id, 'missing');
    }
  }, [bridge, fail, forget]);

  const showInFolder = useCallback((id) => {
    bridge.downloads.showInFolder(id).catch(() => fail(id, 'missing'));
  }, [bridge, fail]);

  const remove = useCallback(async (id) => {
    try {
      await bridge.downloads.remove(id);
      forget(id);
    } catch {
      fail(id, 'deleteFailed');
    }
  }, [bridge, fail, forget]);

  const dismiss = useCallback(() => {
    held.current = false;
    clearTimeout(timer.current);
    setItems([]);
  }, []);

  return { items, hold, open, showInFolder, remove, dismiss };
}
