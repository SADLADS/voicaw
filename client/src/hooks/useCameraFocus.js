import { useEffect } from 'react';
import { useVoice } from './useVoice';
import { focusCamera } from '../voice/voiceClient';
import { t } from '../i18n';

// What clicking someone's camera does (useVolumeMenu's `action`): focuses it, or goes back to
// everyone from the one focused. A camera that's off has none: `null`.
export function cameraFocusAction({ id, name, own, hasCamera, focusedCamera }) {
  const focused = focusedCamera === String(id);
  if (!hasCamera && !focused) return null;
  let label = t('voice.camera.focusHint', { name });
  if (focused) label = t('voice.camera.backToEveryone');
  else if (own) label = t('voice.camera.focusOwnHint');
  return { activate: () => focusCamera(focused ? null : id), label, pressed: focused };
}

const isTyping = (target) => Boolean(target?.closest?.('input:not([type="range"]), textarea, select, [contenteditable="true"]'));
const isSlider = (target) => Boolean(target?.closest?.('input[type="range"]'));

// While a camera is focused on a page: Escape goes back to everyone, the left and right arrows
// step through the cameras (on a slider, they're the slider's). Not while typing, nor over a
// dialog or menu (their keys are theirs).
export function useCameraFocusKeys(active) {
  const { focusedCamera, cameras } = useVoice();
  const focused = active ? focusedCamera : null;
  useEffect(() => {
    if (focused == null) return undefined;
    const onKey = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (e.key === 'Escape') {
        focusCamera(null);
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && cameras.length > 1 && !isSlider(e.target)) {
        const step = e.key === 'ArrowRight' ? 1 : -1;
        const at = cameras.indexOf(focused);
        focusCamera(cameras[(Math.max(at, 0) + step + cameras.length) % cameras.length]);
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, cameras]);
}
