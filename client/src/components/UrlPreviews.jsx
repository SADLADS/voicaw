import React from 'react';
import { youtubeVideoId } from '../utils/youtube';

const URL_PATTERN = /https?:\/\/[^\s)]+/g;

// Embeds for links in a message (currently YouTube videos).
export default function UrlPreviews({ text }) {
  const ids = (text?.match(URL_PATTERN) ?? []).map(youtubeVideoId).filter(Boolean);
  return [...new Set(ids)].map((id) => (
    <div className="youtube-wrapper" key={id}>
      <iframe src={`https://www.youtube.com/embed/${id}`} title="YouTube video" allowFullScreen></iframe>
    </div>
  ));
}
