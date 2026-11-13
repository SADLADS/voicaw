import { useSyncExternalStore } from 'react';
import { t } from '../i18n';
import { createPopoutWindow } from '../voice/popoutWindow';

// A video from a message in a window of its own (Pop out; voice/popoutWindow.js, like a
// stream's): a blank window that VideoPopout draws into. The <video> stays in this page, so
// nothing reloads: the window shows a copy of its picture (captureStream), and its controls
// drive the page's element. Closing the window brings the video back (services/floatingVideo.js).
export const VIDEO_WINDOW_NAME = 'voicaw-video';

const videoWindow = createPopoutWindow({
  name: VIDEO_WINDOW_NAME,
  title: () => t('media.video.windowTitle'),
});

// False: the browser blocked it.
export const openVideoWindow = () => videoWindow.open();
export const closeVideoWindow = () => videoWindow.close();
export const setVideoWindowTitle = (title) => videoWindow.setTitle(title);

// The element the popped-out video is drawn into, or null when it isn't open.
export function useVideoWindow() {
  return useSyncExternalStore(videoWindow.subscribe, videoWindow.get);
}
