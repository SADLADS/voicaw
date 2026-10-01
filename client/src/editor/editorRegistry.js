// Message editors by their editable element, so tests can drive them (a contenteditable
// can't be typed into from jsdom).
const handles = new WeakMap();

export function registerEditor(element, handle) {
  handles.set(element, handle);
}

export function editorFor(element) {
  return handles.get(element);
}
