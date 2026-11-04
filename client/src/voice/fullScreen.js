// Full screen for a voice view's element (a watched stream, a focused camera), in the document
// it's in (a pop-out window's, when it's there): leaves full screen if anything is in it,
// else puts `element` in it. Safari before 16.4 only has the prefixed call.
export function toggleFullScreen(element) {
  const doc = element?.ownerDocument ?? document;
  if (doc.fullscreenElement) doc.exitFullscreen?.()?.catch?.(() => {});
  else (element?.requestFullscreen ?? element?.webkitRequestFullscreen)?.call(element)?.catch?.(() => {});
}

// A double click on a camera's tile: its first click focused it, so what's on the page's stage
// goes full screen.
export function fullScreenStage(event) {
  if (event.target.closest?.('button, input')) return;
  event.preventDefault();
  const stage = event.currentTarget.closest('.voice-view, .call-panel')?.querySelector('.stream-view');
  if (stage) toggleFullScreen(stage);
}
