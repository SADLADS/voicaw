import { useEffect, useRef, useState } from 'react';

// Only drags carrying files (so dragging text still works).
export const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

// Files dropped anywhere on the window, like Discord: while `enabled`, a file dragged in from
// outside the app makes `dragging` true (the caller shows an overlay) and dropping it anywhere
// calls `onFiles(files)`. Ignored: drags that started in the page (an image dragged from a
// message also carries "Files" in Chrome) and drags while a modal is open (`aria-modal`), so
// dialogs keep their own drop targets.
export function useWindowFileDrop({ enabled, onFiles }) {
  const [dragging, setDragging] = useState(false);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    if (!enabled) return undefined;
    // dragenter/dragleave fire for every element crossed; the count is 0 once the drag has
    // left the window.
    let depth = 0;
    let fromPage = false;
    let ignored = false;
    const reset = () => {
      depth = 0;
      ignored = false;
      setDragging(false);
    };
    const onDragStart = () => { fromPage = true; };
    const onDragEnd = () => { fromPage = false; reset(); };
    const onDragEnter = (e) => {
      if (fromPage || !isFileDrag(e)) return;
      if (depth++ === 0) ignored = !!document.querySelector('[aria-modal="true"]');
      if (ignored) return;
      e.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (e) => {
      if (fromPage || !isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) reset();
    };
    const onDragOver = (e) => {
      if (fromPage || ignored || !isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e) => {
      const wasIgnored = ignored;
      reset();
      if (fromPage || wasIgnored || !isFileDrag(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) onFilesRef.current(files);
    };
    window.addEventListener('dragstart', onDragStart);
    window.addEventListener('dragend', onDragEnd);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragstart', onDragStart);
      window.removeEventListener('dragend', onDragEnd);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      setDragging(false);
    };
  }, [enabled]);

  return dragging;
}
