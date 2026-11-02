// Full screen for a voice view's element (a watched stream, a camera's tile), in the document
// it's in (a pop-out window's, when it's there): leaves full screen if anything is in it,
// else puts `element` in it. Safari before 16.4 only has the prefixed call.
export function toggleFullScreen(element) {
  const doc = element?.ownerDocument ?? document;
  if (doc.fullscreenElement) doc.exitFullscreen?.()?.catch?.(() => {});
  else (element?.requestFullscreen ?? element?.webkitRequestFullscreen)?.call(element)?.catch?.(() => {});
}

// Whether `element` is (or is inside) what's full screen now.
export function isFullScreen(element) {
  const shown = element?.ownerDocument?.fullscreenElement;
  return Boolean(shown && shown.contains(element));
}

// A double click on a camera's tile: full screen (or back), as a watched stream's. Its two
// clicks will have opened the volume menu (`closeMenu`), which full screen would hide anyway.
export function fullScreenCamera(event, closeMenu) {
  if (event.target.closest?.('button, input')) return;
  event.preventDefault();
  closeMenu?.();
  toggleFullScreen(event.currentTarget);
}
