// What a voice page shows big, on this device: the focused camera, else the watched stream.
// Both can be set: a stream being watched while a camera is focused keeps playing, with its
// sound, in a small tile (StreamTile) until it's clicked or the camera's focus ends.
export function stageOf({ focusedCamera, watching }) {
  if (focusedCamera != null) return { kind: 'camera', id: focusedCamera };
  if (watching != null) return { kind: 'screen', id: watching };
  return null;
}

// What goes small in the corner once no page shows the stage: never your own (you know what you
// look like, and your screen is your screen), so a watched stream if your own camera is focused.
export function cornerOf({ focusedCamera, watching, identity }) {
  if (focusedCamera != null && focusedCamera !== identity) return { kind: 'camera', id: focusedCamera };
  if (watching != null && watching !== identity) return { kind: 'screen', id: watching };
  return null;
}
