// Where the floating reaction picker goes (desktop): by the button that opened it, lined up
// with its right edge, above it if there's room and otherwise below. The picker sits against
// a zero-size fixed box at that point (see `.reaction-picker-anchor` in dms.css).
const REACTION_PICKER_WIDTH = 360;
const REACTION_PICKER_HEIGHT = 420;

export function reactionPickerPosition(rect) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const pickerHeight = Math.min(REACTION_PICKER_HEIGHT, height * 0.6);
  const left = Math.min(Math.max(rect.right, REACTION_PICKER_WIDTH + 12), width - 12);
  const below = rect.top - pickerHeight - 16 < 0;
  const top = below ? Math.min(rect.bottom, height - pickerHeight - 16) : rect.top;
  return { below, style: { left: `${left}px`, top: `${top}px` } };
}
