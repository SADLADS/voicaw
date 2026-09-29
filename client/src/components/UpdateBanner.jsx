import React, { useState } from 'react';
import { applyUpdate, useAppUpdate } from '../utils/appUpdate';

// A small floating notice when a new version of Voicaw is ready. "Update" switches to it
// (reloading the page); dismissing hides it until the next update. Settings can also check.
export default function UpdateBanner() {
  const { available, seq } = useAppUpdate();
  const [dismissedSeq, setDismissedSeq] = useState(0);
  const [updating, setUpdating] = useState(false);

  if (!available || dismissedSeq === seq) return null;

  const update = () => {
    setUpdating(true);
    applyUpdate();
  };

  return (
    <div className="update-banner" role="status">
      <span>A new version of Voicaw is available.</span>
      <button type="button" className="update-banner-button" onClick={update} disabled={updating}>
        {updating ? 'Updating…' : 'Update'}
      </button>
      {!updating && (
        <button type="button" className="reply-close" onClick={() => setDismissedSeq(seq)} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}
