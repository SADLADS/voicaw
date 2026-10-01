import { useEffect, useState } from 'react';
import { parseAttachmentUrl } from '../services/attachmentCrypto';
import { getCachedAttachment, loadDecryptedAttachment } from '../services/attachmentCache';

// What to put in an <img src> for `url`: an encrypted upload's decrypted copy (a blob URL,
// null while it loads), or any other URL as it is. `failed` if it couldn't be loaded.
export function useAttachmentSrc(url) {
  const meta = url ? parseAttachmentUrl(url) : null;
  const [state, setState] = useState(() => ({ url, src: meta ? getCachedAttachment(url) : url ?? null, failed: false }));

  useEffect(() => {
    const info = url ? parseAttachmentUrl(url) : null;
    if (!info) {
      setState({ url, src: url ?? null, failed: false });
      return undefined;
    }
    const cached = getCachedAttachment(url);
    setState({ url, src: cached, failed: false });
    if (cached) return undefined;
    let cancelled = false;
    loadDecryptedAttachment(url, info)
      .then((src) => { if (!cancelled) setState({ url, src, failed: false }); })
      .catch(() => { if (!cancelled) setState({ url, src: null, failed: true }); });
    return () => { cancelled = true; };
  }, [url]);

  // Until the effect catches up with a new url, nothing (not the previous image).
  if (state.url !== url) return { src: null, failed: false, external: !meta };
  return { src: state.src, failed: state.failed, external: !meta };
}
