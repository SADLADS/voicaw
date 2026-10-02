import React, { useState } from 'react';

// Media behind a cover (hooks/useMediaCover.js): blurred, with `label` ("Spoiler" or "NSFW")
// over it, until clicked (or Enter); then it stays shown. Without a `label`, just `children`.
// While covered, `placeholder` (default: `children`) is drawn instead, inert: out of the image
// viewer's gallery (whose thumbnails would give it away), without video controls or links.
export default function MediaCover({ label, name, placeholder, children }) {
  const [revealed, setRevealed] = useState(false);
  if (!label || revealed) return children;
  return (
    <span className="attachment-spoiler">
      <span className="attachment-spoiler-content" inert>{placeholder ?? children}</span>
      <button
        type="button"
        className="attachment-spoiler-reveal"
        onClick={() => setRevealed(true)}
        aria-label={`${label}: ${name}, select to reveal`}
      >
        {label}
      </button>
    </span>
  );
}
