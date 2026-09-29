// The YouTube video id of a watch/share/shorts link, or null.
export function youtubeVideoId(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.)/, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1);
  else if (host === 'youtube.com' && url.pathname === '/watch') id = url.searchParams.get('v');
  else if (host === 'youtube.com' && url.pathname.startsWith('/shorts/')) id = url.pathname.split('/')[2];
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}
