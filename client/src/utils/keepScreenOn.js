import { android } from './android';

// Keeps the screen from turning itself off until the function returned is called: the Android
// app's own flag (its WebView has no Screen Wake Lock API; an older app without it just
// doesn't), else the browser's Screen Wake Lock where there is one. A browser lets it go when
// the page is hidden.
export function keepScreenOn() {
  if (android) {
    android.keepScreenOn({ on: true }).catch(() => {});
    return () => {
      android.keepScreenOn({ on: false }).catch(() => {});
    };
  }
  let released = false;
  let lock = null;
  globalThis.navigator?.wakeLock?.request('screen')
    .then((granted) => {
      if (released) granted.release().catch(() => {});
      else lock = granted;
    })
    .catch(() => {}); // refused (battery saver, no permission): the screen may still time out
  return () => {
    released = true;
    lock?.release().catch(() => {});
  };
}
