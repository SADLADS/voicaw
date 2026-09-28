import React, { useState } from 'react';

// Shown instead of a conversation whose keys can't be trusted (see contactKeys.js).
export default function ContactKeyWarning({ status, username, onAccept }) {
  const [busy, setBusy] = useState(false);
  const name = username || 'This person';

  if (status === 'invalid') {
    return (
      <div className="contact-key-warning" role="alert">
        <strong>{name}'s encryption keys can't be verified.</strong>
        <p>
          The server sent keys for {name} that aren't properly signed, so they could belong to
          someone else. Messages can't be sent or read in this conversation until that's fixed.
        </p>
      </div>
    );
  }

  const accept = async () => {
    setBusy(true);
    try {
      await onAccept();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="contact-key-warning" role="alert">
      <strong>{name}'s security key has changed.</strong>
      <p>
        This shouldn't normally happen. It can mean someone is trying to intercept your
        messages, or that the server's data was reset. Check with {name} another way (in
        person or on a call) before continuing, and compare safety numbers afterwards.
      </p>
      <button type="button" className="btn btn-sm btn-warning" onClick={accept} disabled={busy}>
        Accept the new key
      </button>
    </div>
  );
}
