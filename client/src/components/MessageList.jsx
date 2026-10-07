import React, { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { useNavigate } from 'react-router-dom';
import { Trans } from 'react-i18next';
import remarkGfm from 'remark-gfm';
import remarkEmoji from 'remark-emoji';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEdit, faTrash, faReply, faFaceSmile, faThumbtack } from '@fortawesome/free-solid-svg-icons';
import Attachment from './Attachment';
import MessageReactions from './MessageReactions';
import UrlPreviews from './UrlPreviews';
import { drawnByApp, SUPPRESS_EMBEDS } from '../utils/linkPreviews';
import MessageEmbeds from './MessageEmbeds';
import MessageFiles from './MessageFiles';
import MessageComponents from './MessageComponents';
import { EphemeralFooter, InteractionHeader, ThinkingLine } from './InteractionNotes';
import { isEphemeral, isThinking } from '../utils/botComponents';
import Poll from './Poll';
import PollEndNotice from './PollEndNotice';
import CallLogNotice from './CallLogNotice';
import { ThreadStartNotice, ThreadSummary } from './guild/ThreadSummary';
import defaultAvatar from '../assets/images/default.png';
import { useLongPress } from '../hooks/useLongPress';
import { useSwipeToReply } from '../hooks/useSwipeToReply';
import MessageEditor from '../editor/MessageEditor';
import { placeholderIdFromUrl, summarizeAttachments } from '../utils/attachmentMarkup';
import { useEmojiIndex } from '../emoji/emojiContext';
import { isEmojiOnly } from '../emoji/emojiIndex';
import { rehypeTwemoji } from '../emoji/rehypeTwemoji';
import { customEmojiToText } from '../emoji/customEmoji';
import { rehypeMentions } from '../utils/rehypeMentions';
import { rehypeHighlightShared } from '../utils/rehypeHighlightShared';
import { isPlainText } from '../utils/plainText';
import { cannotHover, flashRow } from '../utils/flashRow';
import { hideSpoilers, remarkDiscord, remarkDocument } from '../utils/remarkDiscord';
import { continuesGroup, rowTime, startsNewDay } from '../utils/messageGroups';
import { displayName, useProfiles } from '../utils/profiles';
import ProfilePopover from './ProfilePopover';
import Avatar from './Avatar';
import { formatDateTime, formatLongDate, formatTime, useDateFormat } from '../utils/dateFormat';
import { parsePoll, pollEnded } from '../utils/pollMarkup';
import { UNKNOWN_CHANNEL, mentionName, mentionsMe as isForMe, mentionsToText, roleName } from '../utils/mentions';
import { ChannelMentionContext } from '../contexts';
import ChannelIcon from './guild/ChannelIcon';
import { showContent } from '../utils/mobilePanes';
import { parseChannelLink } from '../utils/guildDisplay';
import { pageMenuTarget } from '../utils/pageMenuTarget';
import { useBlocked, useBlockedWebhookIds } from '../utils/blocks';
import BlockedMessage from './BlockedMessage';
import { t } from '../i18n';

// react-markdown's `components` must keep a stable identity: a new function each render
// is a new component type to React, which remounts (and reloads) every attachment on any
// re-render. The per-message local drafts come in through context instead.
const LocalAttachmentsContext = createContext(null);
// Who mentions are, for one message: { names: { id: username }, roles: { id: { name, color } },
// meId, myRoleIds, everyone (whether it pinged @everyone/@here) }.
const MentionContext = createContext(null);

// A spoiler (`||text||`, from remarkDiscord): hidden until clicked (or Enter), then stays shown.
function Spoiler({ children }) {
  const [revealed, setRevealed] = useState(false);
  if (revealed) return <span className="spoiler revealed">{children}</span>;
  const reveal = (e) => {
    e.stopPropagation();
    setRevealed(true);
  };
  return (
    <span
      className="spoiler"
      role="button"
      tabIndex={0}
      aria-label={t('chat.message.spoiler')}
      onClick={reveal}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(e); } }}
    >
      <span aria-hidden="true">{children}</span>
    </span>
  );
}

// A channel mention (`<#id>`): its icon and current name; clicking opens it. One not known yet
// opens the rest of your guilds (ChannelMentionContext); still unknown (you can't see it, or it's
// gone), it's `#unknown-channel` and does nothing. A pasted channel link (MarkdownLink) passes
// its guild too, and shows `unknown` (the link itself) unless the channel is in that guild.
function ChannelMention({ id, guildId, unknown }) {
  const directory = useContext(ChannelMentionContext);
  const navigate = useNavigate();
  const found = directory?.channels[id];
  const channel = found && (guildId == null || String(found.guildId) === guildId) ? found : null;
  const loadAll = directory?.loadAll;
  useEffect(() => {
    if (!channel) loadAll?.();
  }, [channel, loadAll]);
  if (!channel) {
    return unknown ?? <span className="mention channel-mention unknown"><ChannelIcon className="channel-mention-icon" />{UNKNOWN_CHANNEL}</span>;
  }
  const open = (e) => {
    e.stopPropagation();
    showContent();
    navigate(`/guild/${channel.guildId}/${channel.id}`);
  };
  return (
    <span
      className="mention channel-mention"
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter') open(e); }}
    >
      <ChannelIcon channel={channel} className="channel-mention-icon" />{channel.name}
    </span>
  );
}

// A mention (from rehypeMentions): `@name`, highlighted more when it's you; a role in its colour;
// @everyone/@here as a mention only if the message pinged them (else plain text).
// Spoilers (remarkDiscord) are drawn by Spoiler. Other spans (code highlighting) only have a class.
function MarkdownSpan({ className, children, ...rest }) {
  const mentions = useContext(MentionContext);
  if (className === 'spoiler') return <Spoiler>{children}</Spoiler>;
  const id = rest['data-mention-id'];
  const roleId = rest['data-role-mention-id'];
  const everyone = rest['data-mention-everyone'];
  const channelId = rest['data-channel-mention-id'];
  if (channelId != null) return <ChannelMention id={channelId} />;
  if (id != null) {
    const me = String(mentions?.meId) === id;
    return <span className={`mention${me ? ' mention-me' : ''}`} data-user-id={id}>@{mentionName(mentions?.names, id)}</span>;
  }
  if (roleId != null) {
    const color = mentions?.roles?.[roleId]?.color;
    const mine = (mentions?.myRoleIds ?? []).some((r) => String(r) === roleId);
    return (
      <span className={`mention role-mention${mine ? ' mention-me' : ''}`} style={color ? { '--role-color': color } : undefined}>
        @{roleName(mentions?.roles, roleId)}
      </span>
    );
  }
  if (everyone != null) {
    return mentions?.everyone ? <span className="mention mention-me">@{everyone}</span> : <>@{everyone}</>;
  }
  return <span className={className}>{children}</span>;
}

// A custom emoji; one that's been deleted (image gone) shows as `:name:` text.
function CustomEmojiImage({ src, alt, title }) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) return <span className="custom-emoji-missing">{alt}</span>;
  return <img className="emoji custom-emoji" src={src} alt={alt} title={title} draggable={false} onError={() => setFailed(true)} />;
}

function MarkdownImage({ src, alt, className, title, ...rest }) {
  const localAttachments = useContext(LocalAttachmentsContext);
  // Emoji images from rehypeTwemoji, not attachments.
  if (rest['data-custom-emoji'] != null) return <CustomEmojiImage src={src} alt={alt} title={title} />;
  if (className === 'emoji') {
    return <img className="emoji" src={src} alt={alt} title={title} draggable={false} />;
  }
  return <Attachment src={src} alt={alt} localAttachments={localAttachments} />;
}

// A link. A bare link to a guild channel (channelLink, as Copy Link gives it) is drawn as that
// channel's mention for those who can see the channel, and stays a link for everyone else.
// Links always open in a new tab (the desktop app: the browser): following one in the app's own
// page would unload it, and LiveKit leaves voice on unload, even when Electron then cancels the
// navigation.
function MarkdownLink({ node, href, children, ...rest }) {
  const link = <a href={href} {...rest} target="_blank" rel="noopener noreferrer">{children}</a>;
  const target = parseChannelLink(href);
  const text = node?.children?.length === 1 ? node.children[0].value : null;
  if (!target || text !== href) return link;
  return <ChannelMention id={target.channelId} guildId={target.guildId} unknown={link} />;
}

const markdownComponents = { a: MarkdownLink, img: MarkdownImage, span: MarkdownSpan };
// Discord's flavour: GFM for strikethrough and bare links, then remarkDiscord.
const remarkPlugins = [remarkGfm, remarkDiscord, remarkEmoji];

// react-markdown blanks URLs with unknown schemes; let draft placeholders through so
// pending messages can show their attachments while uploading.
function urlTransform(url) {
  return placeholderIdFromUrl(url) !== null ? url : defaultUrlTransform(url);
}

// Markdown with Discord's flavour and our plugins. Text with nothing for markdown to do (most
// embed fields) skips the parser: it would draw the same paragraph (isPlainText).
function MarkdownBody({ text, rehypePlugins }) {
  if (isPlainText(text)) return <p>{text}</p>;
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={urlTransform} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  );
}

// A message's text as markdown (attachments, emoji, mentions, spoilers). `rehypePlugins` and
// `mentions` come from useMessageMarkdown, kept stable so the markdown isn't redone needlessly.
// Memoised: parsing markdown is the costliest part of drawing a message, and rows redraw on
// every hover, page load or name change.
const MessageMarkdown = memo(function MessageMarkdown({ text, localAttachments, rehypePlugins, mentions }) {
  return (
    <LocalAttachmentsContext.Provider value={localAttachments ?? null}>
      <MentionContext.Provider value={mentions}>
        <MarkdownBody text={text} rehypePlugins={rehypePlugins} />
      </MentionContext.Provider>
    </LocalAttachmentsContext.Provider>
  );
});

// A webhook's or a bot's embeds and files (people's messages have none), then the link
// previews the server made in a guild (server/linkPreviews.js; not those for links UrlPreviews
// draws itself), unless Discord's SUPPRESS_EMBEDS is set ("Remove previews", or a webhook or
// bot asked). Markdown in embeds is drawn like the message's own text.
// Memoised like MessageMarkdown: an embed can hold a dozen bits of markdown.
// `onRemove(messageId, event)`: the X beside each link preview (the sender's own embeds have none).
const EmbedParts = memo(function EmbedParts({ embeds: sent, linkEmbeds, attachments, flags, rehypePlugins, mentions, messageId, onRemove }) {
  if (!sent?.length && !attachments?.length && !linkEmbeds?.length) return null;
  const renderMarkdown = (text) => (
    <MentionContext.Provider value={mentions}>
      <MarkdownBody text={text} rehypePlugins={rehypePlugins} />
    </MentionContext.Provider>
  );
  const embeds = flags & SUPPRESS_EMBEDS ? [] : sent ?? [];
  const previews = flags & SUPPRESS_EMBEDS ? [] : (linkEmbeds ?? []).filter((e) => !drawnByApp(e.url));
  return (
    <>
      <MessageEmbeds embeds={embeds} renderMarkdown={renderMarkdown} ownUrls={attachments?.map((a) => a.url)} />
      {/* Files an embed shows (attachment://…) aren't shown again, as in Discord. */}
      <MessageFiles attachments={attachments} shownElsewhere={embeds.flatMap((e) => [e.image?.url, e.thumbnail?.url])} />
      <MessageEmbeds embeds={previews} links onRemove={onRemove ? (event) => onRemove(messageId, event) : undefined} />
    </>
  );
});

// Documents (document channels) are full markdown (remarkDocument: tables, task lists, every
// heading level), drawn with the same mentions, emoji, spoilers and attachments as messages.
const documentRemarkPlugins = [remarkGfm, remarkDocument, remarkEmoji];

export const DocumentMarkdown = memo(function DocumentMarkdown({ text, user, s3Endpoint, reactionNames, mentionRoles, myRoleIds }) {
  const emojiIndex = useEmojiIndex();
  const rehypePlugins = useMemo(
    () => [rehypeHighlightShared, rehypeMentions, rehypeTwemoji(emojiIndex, s3Endpoint)],
    [emojiIndex, s3Endpoint]
  );
  const mentions = useMemo(
    () => ({ names: reactionNames, roles: mentionRoles, meId: user.id, myRoleIds, everyone: false }),
    [reactionNames, mentionRoles, user.id, myRoleIds]
  );
  return (
    <div className="document-body dm-message-content" data-image-gallery="">
      <MentionContext.Provider value={mentions}>
        <ReactMarkdown remarkPlugins={documentRemarkPlugins} rehypePlugins={rehypePlugins} urlTransform={defaultUrlTransform} components={markdownComponents}>
          {text}
        </ReactMarkdown>
      </MentionContext.Provider>
    </div>
  );
});

// What MessageMarkdown and EmbedParts take from a message (only what they draw, so memo works).
const markdownProps = (msg) => ({ text: msg.plaintext, localAttachments: msg.localAttachments });
const embedProps = (msg) => ({ embeds: msg.embeds, linkEmbeds: msg.link_embeds, attachments: msg.attachments, flags: msg.flags });

// A message's content on its own, outside the chat (the pinned messages list): as in the chat,
// without the menu, editor or reactions.
export function MessageContent({ msg, user, s3Endpoint, reactionNames, mentionRoles, myRoleIds }) {
  const emojiIndex = useEmojiIndex();
  const rehypePlugins = useMemo(
    () => [rehypeHighlightShared, rehypeMentions, rehypeTwemoji(emojiIndex, s3Endpoint)],
    [emojiIndex, s3Endpoint]
  );
  const mentions = useMemo(
    () => ({ names: reactionNames, roles: mentionRoles, meId: user.id, myRoleIds, everyone: Boolean(msg.mention_everyone) }),
    [reactionNames, mentionRoles, user.id, myRoleIds, msg.mention_everyone]
  );
  const poll = useMemo(() => parsePoll(msg.plaintext), [msg.plaintext]);
  return (
    <div className={`dm-message-content${isEmojiOnly(msg.plaintext, emojiIndex) ? ' emoji-only' : ''}`} data-image-gallery="">
      {poll
        ? <Poll poll={poll} reactions={msg.reactions} userId={user.id} authorId={msg.sender_id} names={reactionNames} sentAt={msg.timestamp} />
        : <MessageMarkdown {...markdownProps(msg)} rehypePlugins={rehypePlugins} mentions={mentions} />}
      <EmbedParts {...embedProps(msg)} rehypePlugins={rehypePlugins} mentions={mentions} />
    </div>
  );
}

// One message (with its reply snippet, hover menu, right-click menu and inline editor). `grouped`: it follows
// another of the same person's (continuesGroup), so no avatar, name or date, just the time
// when hovered.
export function MessageRow({
  msg,
  grouped = false,
  onOpenProfile,
  user,
  s3Endpoint,
  hoveredMsgId,
  setHoveredMsgId,
  handleEdit,
  handleDelete,
  handleReply,
  editingMessageId,
  editingMessageContent,
  setEditingMessageContent,
  setEditingMessageId,
  handleSaveEdit,
  isMobile,
  editRef,
  maxPlaintextLength,
  onToggleReaction,
  onOpenReactionPicker,
  onVote,
  onAddPollAnswer,
  onRemovePollAnswer,
  onEndPoll,
  onJumpToMessage,
  reactionNames,
  onOpenActions,
  onOpenMenu,
  focusedMsgId,
  replyingToId,
  canModerate = false,
  canAddReactions = true,
  canPin = false,
  onTogglePin,
  // Desktop: the X beside link previews, for those `canRemovePreviews(msg)` says may (ChatPane).
  canRemovePreviews,
  removePreviewsById,
  onRemovePreviews,
  nameColors,
  mentionRoles,
  myRoleIds,
  encrypted = true,
  // Sending messages (a guild channel's Send Messages): also adding answers to open polls.
  canReply = true,
}) {
  const emojiIndex = useEmojiIndex();
  useDateFormat(); // redraws the times when Settings → Date & time changes
  useProfiles(); // and names when someone changes theirs
  // A webhook's message (guilds): its own name and picture as sent, no person behind it.
  const webhook = Boolean(msg.webhook_id);
  const senderName = webhook ? msg.webhook_name : displayName(msg.sender_id, msg.sender_username);
  // A name or avatar opens that person's profile card.
  const profileProps = (id, username) => (onOpenProfile && !webhook ? {
    'data-user-id': id,
    role: 'button',
    tabIndex: 0,
    onClick: (e) => { e.stopPropagation(); onOpenProfile({ id, username }, e.currentTarget.getBoundingClientRect()); },
    onKeyDown: (e) => { if (e.key === 'Enter') onOpenProfile({ id, username }, e.currentTarget.getBoundingClientRect()); },
  } : {});
  // A webhook's name or picture: its right-click menu blocks it (PageMenus).
  const webhookProps = webhook ? { 'data-webhook-id': msg.webhook_id, 'data-webhook-name': senderName } : {};
  // A picker or menu is open for this message: it stays highlighted with its menu showing.
  const focused = focusedMsgId === msg.id;
  // The message being replied to (the composer's "Replying to"): marked until it's sent.
  const replying = replyingToId != null && replyingToId === msg.id;
  // A bot's ephemeral reply (only you see it, until you reload): nothing to do to it but
  // dismiss it, so no menus, reactions or replies. A deferred reply shows "thinking…".
  const ephemeral = isEphemeral(msg);
  const thinking = isThinking(msg);
  const removable = Boolean(onRemovePreviews && canRemovePreviews?.(msg)) && !ephemeral;
  // Mobile: touch and hold opens the message's action sheet (there's no hover there).
  const longPress = useLongPress(() => onOpenActions(msg), { enabled: isMobile && Boolean(onOpenActions) && !ephemeral });
  // Desktop: right-clicking opens its menu, except on a picture, a link, selected text or a
  // text box (editing it), which have their own (PageMenus).
  const onContextMenu = !isMobile && onOpenMenu && !ephemeral ? (e) => {
    if (pageMenuTarget(e.target, document.getSelection()?.toString() ?? '')) return;
    e.preventDefault();
    onOpenMenu(msg, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
  } : undefined;
  // Stable per emoji index (a new plugin list every render would re-run markdown needlessly).
  const rehypePlugins = useMemo(
    () => [rehypeHighlightShared, rehypeMentions, rehypeTwemoji(emojiIndex, s3Endpoint)],
    [emojiIndex, s3Endpoint]
  );

  const mentions = useMemo(
    () => ({ names: reactionNames, roles: mentionRoles, meId: user.id, myRoleIds, everyone: Boolean(msg.mention_everyone) }),
    [reactionNames, mentionRoles, user.id, myRoleIds, msg.mention_everyone]
  );
  const mentionsMe = isForMe(msg, user.id, myRoleIds);
  const mentionChannels = useContext(ChannelMentionContext)?.channels;
  const poll = useMemo(() => parsePoll(msg.plaintext), [msg.plaintext]);


  // Not before the server has the message (it has no id yet).
  const sent = msg.status !== 'pending' && msg.status !== 'failed';
  const canReact = Boolean(onToggleReaction) && sent && !ephemeral;
  const pinned = Boolean(msg.pinned_at);
  // Pinned: a pin by the time (or after the text, without a header).
  const pinMark = pinned ? (
    <FontAwesomeIcon icon={faThumbtack} className="message-pinned" title={t('chat.message.pinned')} aria-label={t('chat.message.pinned')} />
  ) : null;

  const parent = msg.parent_message_id
    ? {
      id: msg.parent_message_id,
      plaintext: msg.parent_plaintext,
      sender_username: msg.parent_username,
      sender_id: msg.parent_sender_id,
    }
    : null;

  return (
    <div
      className={`each-dm-message-wrapper ${msg.sender_id === user.id ? 'sent' : 'received'}${focused ? ' focused' : ''}${replying ? ' replying' : ''}${mentionsMe ? ' mentioned' : ''}${grouped ? ' grouped' : ''}${ephemeral ? ' ephemeral' : ''}`}
      data-msg-id={msg.id}
      onMouseEnter={() => setHoveredMsgId(msg.id)}
      onMouseLeave={() => setHoveredMsgId(null)}
      onContextMenu={onContextMenu}
      onClick={(e) => { if (cannotHover()) flashRow(e.currentTarget, 'tap-highlight'); }}
      {...longPress}
    >
      <InteractionHeader interaction={msg.interaction} />
      {parent && (
        <div className="reply-snippet">
          <Avatar userId={parent.sender_id} alt={displayName(parent.sender_id, parent.sender_username)} className="reply-avatar" />
          <span className="reply-author" style={{ color: nameColors?.[parent.sender_id] }}>{displayName(parent.sender_id, parent.sender_username)}</span>
          <span
            className="reply-preview"
            onClick={() => onJumpToMessage?.(msg.parent_message_id)}
          >
            {/* One line (CSS cuts it with "…" where it runs out of room); the start is plenty. */}
            {mentionsToText(customEmojiToText(hideSpoilers(summarizeAttachments(parent.plaintext))), reactionNames, mentionRoles, mentionChannels)
              ?.replace(/\s+/g, ' ').trim().slice(0, 300) || "…"}
          </span>
        </div>
      )}

      {(focusedMsgId ?? hoveredMsgId) === msg.id && !isMobile && !ephemeral && (
        <div className="message-menu">
          {canReact && canAddReactions && (
            <button
              className="icon-button"
              aria-label={t('chat.reactions.add')}
              // Keep an open picker's outside-click handler from closing it before this toggles it.
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => onOpenReactionPicker(msg, e.currentTarget)}
            >
              <FontAwesomeIcon icon={faFaceSmile} title={t('chat.reactions.add')} />
            </button>
          )}
          {canPin && sent && onTogglePin && (
            <button className={`icon-button pin-button${pinned ? ' active' : ''}`} onClick={() => onTogglePin(msg)}>
              <FontAwesomeIcon icon={faThumbtack} title={pinned ? t('common.unpin') : t('common.pin')} />
            </button>
          )}
          {/* A closed poll can't be edited. */}
          {msg.sender_id === user.id && !(poll && pollEnded(poll, msg.timestamp)) && (
            <button className="icon-button" onClick={() => handleEdit(msg)}>
              <FontAwesomeIcon icon={faEdit} title={t('common.edit')} />
            </button>
          )}
          <button className="icon-button" onClick={() => handleReply(msg)}>
            <FontAwesomeIcon icon={faReply} title={t('common.reply')} />
          </button>
          {(msg.sender_id === user.id || canModerate) && (
            <button
              className="icon-button trash-button"
              // Shift+click deletes without asking (ChatPane).
              onClick={(e) => handleDelete(msg, e)}
            >
              <FontAwesomeIcon icon={faTrash} title={t('common.delete')} />
            </button>
          )}
        </div>
      )}

      <div
        className={`
          dm-message message
          ${msg.sender_id === user.id ? 'sent' : 'received'}
          ${msg.status === 'pending' ? 'pending' : ''}
          ${msg.status === 'failed' ? 'failed' : ''}
        `}
      >
        {grouped ? (
          <small className="message-hover-time" title={formatDateTime(msg.timestamp * 1000, { seconds: true })}>
            {formatTime(msg.timestamp * 1000)}
          </small>
        ) : (
        <>
        {webhook ? (
          // Its picture may be another site's (a webhook's avatar_url): no referrer.
          <img
            className="message-avatar"
            src={msg.webhook_avatar || defaultAvatar}
            alt={senderName}
            referrerPolicy="no-referrer"
            draggable={false}
            onError={(e) => { e.currentTarget.src = defaultAvatar; }}
            {...webhookProps}
          />
        ) : (
          <Avatar
            userId={msg.sender_id}
            alt={senderName}
            className="message-avatar"
            {...profileProps(msg.sender_id, msg.sender_username)}
          />
        )}
        <strong className="message-author" style={{ color: webhook ? undefined : nameColors?.[msg.sender_id] }} {...profileProps(msg.sender_id, msg.sender_username)} {...webhookProps}>{senderName}</strong>{' '}
        {webhook && <span className="app-tag" title={t('chat.message.webhookTitle')}>{t('chat.message.webhookTag')}</span>}{webhook && ' '}
        {msg.sender_bot ? <><span className="app-tag" title={t('chat.message.botTitle')}>{t('chat.message.botTag')}</span>{' '}</> : null}

        <small>
          <span title={formatDateTime(msg.timestamp * 1000, { seconds: true })}>{formatDateTime(msg.timestamp * 1000)}</span>
          {msg.edited ? <em style={{ marginLeft: '6px' }}>{t('chat.message.edited')}</em> : null}
          {pinMark}
          {/* Group DMs: sent before messages were signed (the sender can't be verified), or a
              signature that doesn't match the sender. */}
          {msg.unsigned ? (
            <em className="message-signature unsigned" title={t('chat.message.unsignedTitle')}>{t('chat.message.unsigned')}</em>
          ) : null}
          {msg.unverified ? (
            <em className="message-signature unverified" title={t('chat.message.unverifiedTitle')}>{t('chat.message.unverified')}</em>
          ) : null}
        </small>
        </>
        )}

        {/* The image viewer steps through the images within this (utils/imageGallery.js). */}
        <div
          className={`dm-message-content${isEmojiOnly(msg.plaintext, emojiIndex) ? ' emoji-only' : ''}${grouped && (msg.edited || pinned) ? ' edited-inline' : ''}`}
          data-image-gallery=""
        >
          {editingMessageId === msg.id ? (
            <div className="inline-edit-wrapper">
              <MessageEditor
                ref={editRef}
                id={`edit-input-${msg.id}`}
                className="inline-edit-editor"
                ariaLabel={t('chat.message.editLabel')}
                initialText={editingMessageContent}
                mentionNames={reactionNames}
                mentionRoles={mentionRoles}
                maxLength={maxPlaintextLength}
                // Mobile: Enter is a new line; "save" below saves.
                submitOnEnter={!isMobile}
                onSubmit={() => handleSaveEdit(msg.id)}
                onChange={({ text }) => setEditingMessageContent(text)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setEditingMessageId(null);
                  }
                }}
                autoFocus
              />

              <div className="inline-edit-banner">
                <span>
                  <Trans
                    i18nKey="chat.message.editHint"
                    components={{
                      cancel: <a href="#" onClick={(e) => { e.preventDefault(); setEditingMessageId(null); }} />,
                      save: <a href="#" onClick={(e) => { e.preventDefault(); handleSaveEdit(msg.id); }} />,
                    }}
                  />
                </span>
              </div>
            </div>
          ) : poll ? (
            <Poll
              poll={poll}
              reactions={msg.reactions}
              userId={user.id}
              authorId={msg.sender_id}
              names={reactionNames}
              sentAt={msg.timestamp}
              canModerate={canModerate}
              onVote={canReact && onVote ? (optionIds) => onVote(msg, optionIds) : undefined}
              onAddAnswer={canReact && canReply && onAddPollAnswer ? (text) => onAddPollAnswer(msg, text) : undefined}
              onRemoveAnswer={canReact && onRemovePollAnswer ? (option) => onRemovePollAnswer(msg, option) : undefined}
              onEnd={sent && msg.sender_id === user.id && onEndPoll ? () => onEndPoll(msg) : undefined}
            />
          ) : thinking ? (
            <ThinkingLine botName={senderName} />
          ) : (
            <MessageMarkdown {...markdownProps(msg)} rehypePlugins={rehypePlugins} mentions={mentions} />
          )}
          {/* Without a header to carry it, "edited" goes after the text. */}
          {grouped && msg.edited && editingMessageId !== msg.id ? <small className="message-edited">{t('chat.message.editedInline')}</small> : null}
          {grouped && editingMessageId !== msg.id ? pinMark : null}

          <EmbedParts
            {...embedProps(msg)}
            rehypePlugins={rehypePlugins}
            mentions={mentions}
            messageId={msg.id}
            onRemove={removable ? removePreviewsById : undefined}
          />
          <MessageComponents messageId={msg.id} channelId={msg.channel_id} components={msg.components} names={reactionNames} roles={mentionRoles} />

          {!poll && !(msg.flags & SUPPRESS_EMBEDS) && <UrlPreviews text={msg.plaintext} encrypted={encrypted} onRemove={removable ? (e) => onRemovePreviews(msg, e) : undefined} />}
        </div>

        {msg.thread && msg.system == null && <ThreadSummary thread={msg.thread} />}

        {canReact && (
          <MessageReactions
            reactions={msg.reactions}
            userId={user.id}
            names={reactionNames}
            onToggle={(emoji) => onToggleReaction(msg, emoji)}
            onAdd={canAddReactions ? (anchor) => onOpenReactionPicker(msg, anchor) : undefined}
          />
        )}
        {ephemeral && <EphemeralFooter messageId={msg.id} />}

      </div>
      {/* Mobile: shows from the right as the message is swiped left (useSwipeToReply). */}
      {isMobile && sent && !ephemeral && (
        <span className="swipe-reply-icon" aria-hidden="true">
          <FontAwesomeIcon icon={faReply} />
        </span>
      )}
    </div>
  );
}

// How close to the top (in viewport heights) to start fetching older history, so it's
// usually in place before the user gets there.
const LOAD_OLDER_WITHIN_VIEWPORTS = 1.5;
// Within this many px of the bottom counts as "at the bottom" (keep following new messages).
const PINNED_TOLERANCE_PX = 4;

const rowKey = (msg) => String(msg.clientKey ?? msg.id);

// The line with the date across the chat where a new day starts (startsNewDay).
function DayDivider({ time }) {
  useDateFormat(); // redraws when Settings → Date & time changes
  return (
    <div className="day-divider" role="separator">
      <span>{formatLongDate(time)}</span>
    </div>
  );
}

// Discord's red line above the first unread message, "New" at its end; with the date in the
// middle when a new day starts there too (one line instead of two).
function NewDivider({ time }) {
  useDateFormat();
  return (
    <div className="new-divider" role="separator" aria-label={t('chat.newDivider.label')}>
      <span className="new-divider-line" />
      {time != null && <span className="new-divider-date">{formatLongDate(time)}</span>}
      {time != null && <span className="new-divider-line" />}
      <span className="new-divider-pill" aria-hidden="true">{t('chat.newDivider.pill')}</span>
    </div>
  );
}

// Chrome/Firefox keep the visible content still when things above it change size or are
// inserted (CSS scroll anchoring). Safari doesn't, so there we do it ourselves.
const NATIVE_SCROLL_ANCHORING =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('overflow-anchor', 'auto');

// A plain (non-virtualized) scrolling list. Virtualized lists have to guess the height of
// rows they haven't rendered and correct it afterwards, which shows as the content jumping
// while scrolling up; with every row rendered, the browser always knows the real layout.
export default function MessageList({
  messages,
  user,
  hasMore,
  loadMoreMessages,
  s3Endpoint,
  hoveredMsgId,
  setHoveredMsgId,
  handleEdit,
  handleDelete,
  handleReply,
  editingMessageId,
  editingMessageContent,
  setEditingMessageContent,
  setEditingMessageId,
  handleSaveEdit,
  isMobile,
  editRef,
  maxPlaintextLength,
  onToggleReaction,
  onOpenReactionPicker,
  onVote,
  onAddPollAnswer,
  onRemovePollAnswer,
  onEndPoll,
  onJumpToMessage,
  reactionNames,
  onOpenActions,
  onOpenMenu,
  focusedMsgId,
  replyingToId,
  canModerate,
  canAddReactions,
  canPin,
  onTogglePin,
  canRemovePreviews,
  onRemovePreviews,
  nameColors,
  mentionRoles,
  myRoleIds,
  encrypted = true,
  canReply = true,
  head = null,
  newFrom = null,
}) {
  const scrollerRef = useRef(null);
  const contentRef = useRef(null);
  // People and webhooks you've blocked: their messages are collapsed (BlockedMessage).
  const blocked = useBlocked();
  const blockedWebhooks = useBlockedWebhookIds();
  // Following the newest message (true until the user scrolls away from the bottom).
  const pinnedToBottom = useRef(true);
  // The list's own height when last seen, to tell the list resizing apart from user scrolling.
  const lastListHeight = useRef(null);
  // Manual anchoring only: the first visible row and its position within the content.
  // Scrolling doesn't change that position; content changing above the row does, and that
  // difference is exactly how far to scroll to keep the row still.
  const anchor = useRef(null);

  const latest = useRef({ hasMore, loadMoreMessages, messages, setHoveredMsgId, isMobile, onRemovePreviews });
  latest.current = { hasMore, loadMoreMessages, messages, setHoveredMsgId, isMobile, onRemovePreviews };
  // The previews' X by message id, the same function every render, so memoised EmbedParts stay drawn.
  const removePreviewsById = useCallback((id, event) => {
    const msg = latest.current.messages.find((m) => m.id === id);
    if (msg) latest.current.onRemovePreviews?.(msg, event);
  }, []);

  // Where the mouse pointer is (null outside the window), for rehover.
  const pointer = useRef(null);
  useEffect(() => {
    const onMove = (e) => { pointer.current = { x: e.clientX, y: e.clientY }; };
    const onOut = (e) => { if (!e.relatedTarget) pointer.current = null; };
    window.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mouseout', onOut);
    return () => {
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseout', onOut);
    };
  }, []);

  // The hover menu follows mouseenter/mouseleave, which only fire when the mouse moves: a row
  // that moves under a still pointer (the next one, after the hovered message is deleted) gets
  // no mouseenter, and a deleted row never says the mouse left it. So whenever the rows change
  // or shift, the hovered row is worked out again from where the pointer is.
  const rehover = useCallback(() => {
    const at = pointer.current;
    const { messages: rows, setHoveredMsgId: setHovered, isMobile: phone } = latest.current;
    if (!at || phone || !setHovered) return;
    const row = document.elementFromPoint(at.x, at.y)?.closest('[data-msg-id]');
    const msg = row && scrollerRef.current?.contains(row)
      ? rows.find((each) => String(each.id) === row.dataset.msgId)
      : null;
    setHovered(msg ? msg.id : null);
  }, []);

  // The profile card open from a name or avatar: { user, anchor (rect) }.
  const [profileFor, setProfileFor] = useState(null);
  const closeProfile = useCallback(() => setProfileFor(null), []);
  const openProfile = useCallback((person, anchor) => setProfileFor({ user: person, anchor }), []);

  // Mobile: swiping a message left replies to it (where there's a message box to reply in).
  const repliable = (key) => {
    const msg = messages.find((each) => rowKey(each) === key);
    return msg && !msg.system && !isEphemeral(msg) && msg.status !== 'pending' && msg.status !== 'failed' ? msg : null;
  };
  useSwipeToReply(scrollerRef, {
    enabled: isMobile && canReply,
    canReply: (key) => Boolean(repliable(key)),
    onReply: (key) => {
      const msg = repliable(key);
      if (msg) handleReply(msg);
    },
  });

  const rowProps = {
    onOpenProfile: openProfile,
    user,
    s3Endpoint,
    hoveredMsgId,
    setHoveredMsgId,
    handleEdit,
    handleDelete,
    handleReply,
    editingMessageId,
    editingMessageContent,
    setEditingMessageContent,
    setEditingMessageId,
    handleSaveEdit,
    isMobile,
    editRef,
    maxPlaintextLength,
    onToggleReaction,
    onOpenReactionPicker,
    onVote,
    onAddPollAnswer,
    onRemovePollAnswer,
    onEndPoll,
    onJumpToMessage,
    reactionNames,
    onOpenActions,
    onOpenMenu,
    focusedMsgId,
    replyingToId,
    canModerate,
    canAddReactions,
    canPin,
    onTogglePin,
    canRemovePreviews,
    removePreviewsById,
    onRemovePreviews,
    nameColors,
    mentionRoles,
    myRoleIds,
    encrypted,
    canReply,
  };

  const rememberAnchor = useCallback(() => {
    if (NATIVE_SCROLL_ANCHORING) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    for (const row of contentRef.current.children) {
      if (row.offsetTop + row.offsetHeight > scroller.scrollTop) {
        anchor.current = { key: row.dataset.key, top: row.offsetTop };
        return;
      }
    }
    anchor.current = null;
  }, []);

  // Keep the view where it should be after the content changed: at the bottom if we're
  // following new messages, otherwise (without native anchoring) with the anchor row still.
  const keepAnchorInPlace = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (pinnedToBottom.current) {
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    if (NATIVE_SCROLL_ANCHORING) return;
    const saved = anchor.current;
    const row = saved && [...contentRef.current.children].find((el) => el.dataset.key === saved.key);
    if (!row) return;
    const drift = row.offsetTop - saved.top;
    if (Math.abs(drift) >= 1) scroller.scrollTop += drift;
  }, []);

  const maybeLoadOlder = useCallback(() => {
    const scroller = scrollerRef.current;
    const { hasMore: more, loadMoreMessages: load } = latest.current;
    if (!scroller || !more) return;
    if (scroller.scrollTop < scroller.clientHeight * LOAD_OLDER_WITHIN_VIEWPORTS) load();
  }, []);

  const handleScroll = () => {
    const scroller = scrollerRef.current;
    // The list itself just changed height (keyboard / mobile emoji panel). The browser's scroll
    // anchoring may nudge scrollTop, firing this before the ResizeObserver runs: that isn't
    // the user scrolling away, so stay at the bottom if we were there.
    const resized = lastListHeight.current !== null && scroller.clientHeight !== lastListHeight.current;
    lastListHeight.current = scroller.clientHeight;
    if (resized && pinnedToBottom.current) {
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    pinnedToBottom.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= PINNED_TOLERANCE_PX;
    // Content may have shifted since the anchor was recorded (e.g. an image above loaded in
    // the same frame as this scroll): correct that before recording the new position.
    if (!pinnedToBottom.current) keepAnchorInPlace();
    rememberAnchor();
    maybeLoadOlder();
  };

  // The last row's key, to notice a message added at the end.
  const lastRowKey = useRef(null);

  // After messages change (older page prepended, new message appended, …), before paint.
  useLayoutEffect(() => {
    const last = messages[messages.length - 1];
    const lastKey = last ? rowKey(last) : null;
    // Sending a message (it shows at once as pending) goes back to the bottom, like Discord.
    if (lastKey !== lastRowKey.current && last?.status === 'pending' && last.sender_id === user.id) {
      pinnedToBottom.current = true;
    }
    lastRowKey.current = lastKey;
    keepAnchorInPlace();
    rememberAnchor();
    // Keep fetching until the viewport is filled or history runs out.
    maybeLoadOlder();
    rehover();
  }, [messages, hasMore, user.id, keepAnchorInPlace, rememberAnchor, maybeLoadOlder, rehover]);

  // Rows changing size (images/videos loading, code highlighting, edits), and the list itself
  // changing height (keyboard or mobile emoji panel opening). ResizeObserver callbacks run
  // after layout but before paint, so the correction is never seen.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      keepAnchorInPlace();
      rememberAnchor();
      lastListHeight.current = scrollerRef.current?.clientHeight ?? null;
      rehover();
    });
    observer.observe(contentRef.current);
    observer.observe(scrollerRef.current);
    return () => observer.disconnect();
  }, [keepAnchorInPlace, rememberAnchor, rehover]);

  // The "New" divider goes above the first message from `newFrom` on (useNewDivider).
  const newIndex = useMemo(
    () => (newFrom == null ? -1 : messages.findIndex((m) => Number.isInteger(m.id) && m.id >= newFrom)),
    [messages, newFrom]
  );

  return (
    <div
      className={`message-scroller${focusedMsgId != null ? ' has-focused-message' : ''}`}
      ref={scrollerRef}
      onScroll={handleScroll}
    >
      <div className="message-scroller-content" ref={contentRef}>
        {/* What comes before the first message (a thread's start), once history reaches it. */}
        {head && !hasMore && <div data-key="list-head">{head}</div>}
        {messages.map((msg, i) => (
          <div key={rowKey(msg)} data-key={rowKey(msg)}>
            {i === newIndex
              ? <NewDivider time={startsNewDay(messages[i - 1], msg, { hasMore }) ? rowTime(msg) : null} />
              : startsNewDay(messages[i - 1], msg, { hasMore }) && <DayDivider time={rowTime(msg)} />}
            {/* A poll's result when it closed, a call; group DMs: membership changes, between the messages. */}
            {msg.system === 'poll_end'
              ? <PollEndNotice msg={msg} onJump={onJumpToMessage} />
              : msg.system === 'call'
              ? <CallLogNotice msg={msg} meId={user?.id} />
              : msg.system === 'thread'
              ? <ThreadStartNotice msg={msg} />
              : msg.system
              ? <p className="message-system">{msg.text}</p>
              : (msg.webhook_id ? blockedWebhooks.has(Number(msg.webhook_id)) : blocked.has(Number(msg.sender_id)))
              ? <BlockedMessage><MessageRow msg={msg} grouped={false} {...rowProps} /></BlockedMessage>
              : <MessageRow msg={msg} grouped={i !== newIndex && continuesGroup(messages[i - 1], msg)} {...rowProps} />}
          </div>
        ))}
      </div>
      {profileFor && <ProfilePopover user={profileFor.user} anchor={profileFor.anchor} onClose={closeProfile} />}
    </div>
  );
}
