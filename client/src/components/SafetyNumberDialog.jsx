import React, { useEffect, useState } from 'react';
import { loadOwnPublicKeys } from '../services/keyStore';
import { setContactVerified } from '../services/contactKeys';
import { computeSafetyNumber } from '../services/safetyNumber';

// Compare this number with the other person (in person or on a call). If it matches, nobody
// has swapped either of your keys, and the contact can be marked verified.
export default function SafetyNumberDialog({ me, contact, verified, onChange, onClose }) {
  const [number, setNumber] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // My own identity key comes from my own key backup, not from the server.
      const own = await loadOwnPublicKeys();
      if (!own) throw new Error('This device has no encryption keys. Log out and log in again.');
      const value = await computeSafetyNumber(
        { id: me.id, identityKey: own.identityKey },
        { id: contact.id, identityKey: contact.identity_key }
      );
      if (!cancelled) setNumber(value);
    })().catch((err) => !cancelled && setError(err.message));
    return () => { cancelled = true; };
  }, [me.id, contact.id, contact.identity_key]);

  const toggle = async () => {
    await setContactVerified(me.id, contact.id, !verified);
    onChange(!verified);
  };

  return (
    <div className="safety-number-backdrop" onClick={onClose}>
      <div
        className="safety-number-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Safety number with ${contact.username}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h5>Safety number with {contact.username}</h5>
        <p>
          Compare this with {contact.username} in person or on a call. If both of you see the
          same number, your conversation can't be intercepted by the server.
        </p>
        {error ? (
          <p className="error-text">{error}</p>
        ) : (
          <div className="safety-number" aria-label="Safety number">
            {number ? number.split(' ').map((group, i) => <span key={i}>{group}</span>) : 'Calculating…'}
          </div>
        )}
        <div className="safety-number-actions">
          {number && (
            <button type="button" className={`btn btn-sm ${verified ? 'btn-secondary' : 'btn-success'}`} onClick={toggle}>
              {verified ? 'Mark as not verified' : 'Mark as verified'}
            </button>
          )}
          <button type="button" className="btn btn-sm btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
