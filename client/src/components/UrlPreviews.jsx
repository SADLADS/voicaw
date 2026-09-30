import React from 'react';
import { youtubeVideoId } from '../utils/youtube';
import { inviteCodeFromUrl } from '../utils/inviteLinks';
import InviteEmbed from './guild/InviteEmbed';

const URL_PATTERN = /https?:\/\/[^\s)]+/g;

// Embeds for links in a message: Voicaw guild invites and YouTube videos. The player comes
// from youtube-nocookie.com, which sets no cookies until the video is played.
// `encrypted`: the chat is end-to-end encrypted, so invites only load when tapped (see
// InviteEmbed).
export default function UrlPreviews({ text, encrypted = false }) {
  const links = text?.match(URL_PATTERN) ?? [];
  const inviteCodes = [...new Set(links.map(inviteCodeFromUrl).filter(Boolean))];
  const videoIds = [...new Set(links.map(youtubeVideoId).filter(Boolean))];
  return (
    <>
      {inviteCodes.map((code) => <InviteEmbed key={code} code={code} autoLoad={!encrypted} />)}
      {videoIds.map((id) => (
        <div className="youtube-wrapper" key={id}>
          <iframe src={`https://www.youtube-nocookie.com/embed/${id}`} title="YouTube video" allowFullScreen></iframe>
        </div>
      ))}
    </>
  );
}
