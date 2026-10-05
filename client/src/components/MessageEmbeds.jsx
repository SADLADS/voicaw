import React from 'react';
import { formatDateTime, useDateFormat } from '../utils/dateFormat';
import { useMediaCover } from '../hooks/useMediaCover';
import { usePrivacyPrefs } from '../utils/privacy';
import MediaCover from './MediaCover';
import SiteMediaGate from './SiteMediaGate';
import { SiteImage, SiteVideo } from './LinkMedia';
import { t } from '../i18n';

// Links in embeds open in a new tab, telling the site nothing about where they came from.
function EmbedLink({ href, className, children }) {
  return <a href={href} className={className} target="_blank" rel="noopener noreferrer">{children}</a>;
}

// An image from the embed: another site's (`external`: loaded straight from it, no referrer;
// held back by SiteMediaGate while Settings → Privacy says so) or a file sent with the message.
// Its size, when known, is kept so the box is right before it loads. Covered in an NSFW channel.
function EmbedImage({ image, className, external, compact = false }) {
  const cover = useMediaCover();
  const img = (
    <MediaCover label={cover} name={t('media.embeds.image')}>
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
  return external ? <SiteMediaGate url={image.url} compact={compact}>{img}</SiteMediaGate> : img;
}

const colorHex = (color) => `#${color.toString(16).padStart(6, '0')}`;

// One of Discord's embeds (a webhook's or a bot's, or a link preview's card): coloured bar,
// provider, author, title, description (markdown, or plain text without `renderMarkdown`),
// fields (inline ones side by side), image (or a video file, with the image as its poster),
// thumbnail, footer and time. `isExternal(url)`: a picture from another site, not a file sent
// with the message; its small icons are left out while Settings → Privacy holds such pictures back.
function Embed({ embed, renderMarkdown, isExternal }) {
  const { author, provider, footer, fields = [], thumbnail, image, video } = embed;
  const autoLoad = usePrivacyPrefs().linkPreviews;
  const icon = (url) => (url && (autoLoad || !isExternal(url)) ? url : null);
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
            {icon(author.icon_url) && <img className="embed-author-icon" src={author.icon_url} alt="" referrerPolicy="no-referrer" />}
            {author.url ? <EmbedLink href={author.url}>{author.name}</EmbedLink> : <span>{author.name}</span>}
          </div>
        )}
        {embed.title && (
          <div className="embed-title">
            {embed.url ? <EmbedLink href={embed.url}>{embed.title}</EmbedLink> : embed.title}
          </div>
        )}
        {embed.description && <div className="embed-description">{renderMarkdown ? renderMarkdown(embed.description) : embed.description}</div>}
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
        {video?.url ? (
          <SiteVideo url={video.url} link={embed.url} width={video.width ?? image?.width} height={video.height ?? image?.height} poster={image?.url} />
        ) : image && <EmbedImage image={image} className="embed-image" external={isExternal(image.url)} />}
        {(footer || time) && (
          <div className="embed-footer">
            {icon(footer?.icon_url) && <img className="embed-footer-icon" src={footer.icon_url} alt="" referrerPolicy="no-referrer" />}
            <span>
              {footer?.text && time ? t('media.embeds.footerWithTime', { text: footer.text, time }) : footer?.text || time}
            </span>
          </div>
        )}
      </div>
      {thumbnail && <EmbedImage image={thumbnail} className="embed-thumbnail" external={isExternal(thumbnail.url)} compact />}
    </article>
  );
}

// A link preview (server/linkPreviews.js): a link straight to a picture or a video shows just
// that, anything else a card with plain text (it's another site's words, not markdown).
function LinkEmbed({ embed }) {
  if (embed.type === 'image' && embed.thumbnail?.url) {
    return <SiteImage url={embed.thumbnail.url} link={embed.url} width={embed.thumbnail.width} height={embed.thumbnail.height} />;
  }
  if (embed.type === 'video' && embed.video?.url && !embed.title && !embed.description) {
    return <SiteVideo url={embed.video.url} link={embed.url} width={embed.video.width} height={embed.video.height} />;
  }
  return <Embed embed={embed} isExternal={() => true} />;
}

// A message's embeds. `renderMarkdown(text)` draws markdown as the message's own text is drawn;
// `ownUrls`: the message's own files (an embed showing one isn't another site's picture).
// `links`: these are the server's link previews (LinkEmbed), not the sender's own embeds.
export default function MessageEmbeds({ embeds, renderMarkdown, ownUrls, links = false }) {
  useDateFormat();
  if (!embeds?.length) return null;
  const isExternal = (url) => !ownUrls?.includes(url);
  return (
    <div className="message-embeds">
      {embeds.map((embed, i) => (links
        ? <LinkEmbed key={i} embed={embed} />
        : <Embed key={i} embed={embed} renderMarkdown={renderMarkdown} isExternal={isExternal} />))}
    </div>
  );
}
