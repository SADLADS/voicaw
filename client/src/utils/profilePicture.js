// Tells the open app a profile picture was just replaced, so it can show the new one instead
// of the browser's cached copy (same URL).
const EVENT = 'voicaw:profile-picture-changed';

export function announceProfilePictureChange() {
  window.dispatchEvent(new Event(EVENT));
}

export function onProfilePictureChange(callback) {
  window.addEventListener(EVENT, callback);
  return () => window.removeEventListener(EVENT, callback);
}
