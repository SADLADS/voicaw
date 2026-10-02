import React from 'react';
import { formatDateTime, useDateFormat } from '../utils/dateFormat';
import { useMediaCover } from '../hooks/useMediaCover';
import MediaCover from './MediaCover';

// Links in embeds open in a new tab, telling the site nothing about where they came from.
function EmbedLink({ href, className, children }) {
  return <a href={href} className={className} target="_blank" rel="noopener noreferrer">{children}</a>;
}

// An image from the embed: another site's (loaded straight from it, no referrer) or a file sent
// with the message. Its size, when known, is kept so the box is right before it loads. Covered
// in an NSFW channel.
function EmbedImage({ image, className }) {
  const cover = useMediaCover();
  return (
    <MediaCover label={cover} name="embedded image">
      <img
        className={className}
        src={image.url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        width={image.width}
        height={image.height}
      />
    </MediaCover>
  );
}

const colorHex = (color) => `#${color.toString(16).padStart(6, '0')}`;

// One of Discord's embeds (a webhook's message): coloured bar, provider, author, title,
// description (markdown), fields (inline ones side by side), image, thumbnail, footer and time.
function Embed({ embed, renderMarkdown }) {
  const { author, provider, footer, fields = [], thumbnail, image } = embed;
  const time = embed.timestamp ? formatDateTime(Date.parse(embed.timestamp)) : null;
  return (
    <article className="embed" style={embed.color != null ? { '--embed-color': colorHex(embed.color) } : undefined}>
      <div className="embed-body">
        {provider?.name && (
          <div className="embed-provider">
            {provider.url ? <EmbedLink href={provider.url}>{provider.name}</EmbedLink> : provider.name}
          </div>
        )}
        {author && (
          <div className="embed-author">
            {author.icon_url && <img className="embed-author-icon" src={author.icon_url} alt="" referrerPolicy="no-referrer" />}
            {author.url ? <EmbedLink href={author.url}>{author.name}</EmbedLink> : <span>{author.name}</span>}
          </div>
        )}
        {embed.title && (
          <div className="embed-title">
            {embed.url ? <EmbedLink href={embed.url}>{embed.title}</EmbedLink> : embed.title}
          </div>
        )}
        {embed.description && <div className="embed-description">{renderMarkdown(embed.description)}</div>}
        {fields.length > 0 && (
          <div className="embed-fields">
            {fields.map((field, i) => (
              <div key={i} className={`embed-field${field.inline ? ' inline' : ''}`}>
                <div className="embed-field-name">{renderMarkdown(field.name)}</div>
                <div className="embed-field-value">{renderMarkdown(field.value)}</div>
              </div>
            ))}
          </div>
        )}
        {image && <EmbedImage image={image} className="embed-image" />}
        {(footer || time) && (
          <div className="embed-footer">
            {footer?.icon_url && <img className="embed-footer-icon" src={footer.icon_url} alt="" referrerPolicy="no-referrer" />}
            <span>
              {footer?.text}
              {footer?.text && time ? ' • ' : ''}
              {time}
            </span>
          </div>
        )}
      </div>
      {thumbnail && <EmbedImage image={thumbnail} className="embed-thumbnail" />}
    </article>
  );
}

// A message's embeds. `renderMarkdown(text)` draws markdown as the message's own text is drawn.
export default function MessageEmbeds({ embeds, renderMarkdown }) {
  useDateFormat();
  if (!embeds?.length) return null;
  return (
    <div className="message-embeds">
      {embeds.map((embed, i) => <Embed key={i} embed={embed} renderMarkdown={renderMarkdown} />)}
    </div>
  );
}
