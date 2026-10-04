// The YouTube video id of a watch, share, shorts, live or embed link, or null.
export function youtubeVideoId(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  const [, first, second] = url.pathname.split('/');
  let id = null;
  if (host === 'youtu.be') id = first;
  else if (host === 'youtube.com' && url.pathname === '/watch') id = url.searchParams.get('v');
  else if ((host === 'youtube.com' || host === 'youtube-nocookie.com') && ['shorts', 'live', 'embed'].includes(first)) id = second;
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}
