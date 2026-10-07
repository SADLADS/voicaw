import { useCallback, useEffect, useRef, useState } from 'react';
import { isAndroidApp, listMedia, mediaAccess, mediaThumbnail, requestMediaAccess } from '../utils/android';

const PAGE = 60;

// Thumbnails already made this session, by uri (data: URLs, a few KB each).
const thumbnails = new Map();

// A data: URL of `item`'s thumbnail, made once its tile (`ref`) scrolls near view; null until then.
export function useMediaThumbnail(item, ref) {
  const [url, setUrl] = useState(() => thumbnails.get(item.uri) ?? null);
  useEffect(() => {
    if (url || !ref.current) return undefined;
    let cancelled = false;
    const load = () => mediaThumbnail(item)
      .then((made) => {
        thumbnails.set(item.uri, made);
        if (!cancelled) setUrl(made);
      })
      .catch(() => {});
    if (typeof IntersectionObserver === 'undefined') {
      load();
      return () => { cancelled = true; };
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      load();
    }, { rootMargin: '200px' });
    observer.observe(ref.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [item, ref, url]);
  return url;
}

// The phone's photos and videos, newest first, for the + panel's grid. Only the Android app can
// list them (a web page only gets the file chooser): elsewhere `access` is 'unsupported'.
// `access`: null while checking, then 'all' | 'some' | 'none' (see utils/android.js). `more()`
// loads the next page; `request()` asks Android (again, to choose more when only some).
export function useDeviceMedia({ enabled }) {
  const supported = isAndroidApp();
  const [access, setAccess] = useState(supported ? null : 'unsupported');
  const [items, setItems] = useState([]);
  const [done, setDone] = useState(false);
  const loading = useRef(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const load = useCallback(async (reset) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const offset = reset ? 0 : itemsRef.current.length;
      const page = await listMedia(offset, PAGE);
      setItems((prev) => (reset ? page : [...prev, ...page]));
      setDone(page.length < PAGE);
    } catch (err) {
      console.warn('Could not list photos', err);
      setDone(true);
    } finally {
      loading.current = false;
    }
  }, []);

  const refresh = useCallback(async (next) => {
    setAccess(next);
    if (next === 'none') {
      setItems([]);
      setDone(true);
    } else {
      await load(true);
    }
  }, [load]);

  // Checked each time the panel opens: access can change in Android's settings meanwhile, and
  // new photos may have been taken.
  useEffect(() => {
    if (!supported || !enabled) return;
    let cancelled = false;
    mediaAccess()
      .then((next) => { if (!cancelled) refresh(next); })
      .catch((err) => console.warn('Could not check photo access', err));
    return () => { cancelled = true; };
  }, [supported, enabled, refresh]);

  const request = useCallback(async () => {
    try {
      await refresh(await requestMediaAccess());
    } catch (err) {
      console.warn('Could not ask for photo access', err);
    }
  }, [refresh]);

  const more = useCallback(() => {
    if (!done && access !== 'none' && access !== 'unsupported') load(false);
  }, [done, access, load]);

  return { access, items, done, more, request };
}
