import { useEffect, useState } from 'react';
import { desktop } from '../utils/desktop';

// The desktop app's window, for its title bar (components/DesktopTitleBar.jsx):
// { maximized, fullScreen, focused }, kept up to date.
export function useDesktopWindowState() {
  const [state, setState] = useState({ maximized: false, fullScreen: false, focused: true });
  useEffect(() => {
    if (!desktop?.onWindowState) return undefined;
    let stale = false;
    const stop = desktop.onWindowState(setState);
    desktop.getWindowState().then((now) => { if (!stale && now) setState(now); }).catch(() => {});
    return () => {
      stale = true;
      stop();
    };
  }, []);
  return state;
}

// Whether the history has somewhere to go back or forward to (the title bar's arrows). The
// Navigation API knows; without it (older Chromium) both are taken as possible.
export function useHistoryMoves() {
  const nav = typeof window !== 'undefined' ? window.navigation : undefined;
  const read = () => ({ back: nav?.canGoBack ?? true, forward: nav?.canGoForward ?? true });
  const [moves, setMoves] = useState(read);
  useEffect(() => {
    if (!nav) return undefined;
    const update = () => setMoves(read());
    nav.addEventListener('currententrychange', update);
    return () => nav.removeEventListener('currententrychange', update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return moves;
}
