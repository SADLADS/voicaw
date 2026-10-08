import { t } from '../i18n';
import { createPopoutWindow } from './popoutWindow';

// The watched screen share in a window of its own (popoutWindow.js): a blank window that
// StreamPopout draws the stream into (same origin, so the <video> plays the same LiveKit
// track). It closes when you stop watching (or the stream ends, or you leave voice); closing it
// puts the stream back where it was (the page, or the corner).
export const STREAM_WINDOW_NAME = 'voicaw-stream';

const streamWindow = createPopoutWindow({
  name: STREAM_WINDOW_NAME,
  title: () => t('voice.stream.defaultWindowTitle'),
});

// False: the browser blocked it.
export const openStreamWindow = () => streamWindow.open();
export const closeStreamWindow = () => streamWindow.close();
export const setStreamWindowTitle = (title) => streamWindow.setTitle(title);
// The element the popped-out stream is drawn into, or null when it isn't popped out.
export const getStreamWindow = () => streamWindow.get();
export const onStreamWindowChange = (listener) => streamWindow.subscribe(listener);
