// Saves an object (blob:) URL as a file called `name`.
export function triggerDownload(objectUrl, name) {
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function openInNewTab(url) {
  // Decrypted attachments are blob: URLs, which only resolve in a page from the same origin
  // and browsing-context group, so those can't be opened with noopener.
  if (url.startsWith('blob:')) window.open(url, '_blank');
  else window.open(url, '_blank', 'noopener,noreferrer');
}

// Attachments are already blob: URLs. Other images (legacy uploads, external links) are
// fetched first, since browsers ignore `download` on cross-origin links; when the server
// doesn't allow that (CORS), they're opened in a new tab to save from there instead.
export async function saveUrlAs(url, name) {
  if (url.startsWith('blob:')) {
    triggerDownload(url, name);
    return;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const objectUrl = URL.createObjectURL(await res.blob());
    triggerDownload(objectUrl, name);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch {
    openInNewTab(url);
  }
}
