import React, { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { useNavigate } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import remarkEmoji from 'remark-emoji';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEdit, faTrash, faReply, faFaceSmile, faThumbtack } from '@fortawesome/free-solid-svg-icons';
import Attachment from './Attachment';
import MessageReactions from './MessageReactions';
import UrlPreviews from './UrlPreviews';
import MessageEmbeds from './MessageEmbeds';
import MessageFiles from './MessageFiles';
import Poll from './Poll';
import PollEndNotice from './PollEndNotice';
import CallLogNotice from './CallLogNotice';
import defaultAvatar from '../assets/images/default.png';
import { useLongPress } from '../hooks/useLongPress';
import MessageEditor from '../editor/MessageEditor';
import { placeholderIdFromUrl, summarizeAttachments } from '../utils/attachmentMarkup';
import { useEmojiIndex } from '../emoji/emojiContext';
import { isEmojiOnly } from '../emoji/emojiIndex';
import { rehypeTwemoji } from '../emoji/rehypeTwemoji';
import { customEmojiToText } from '../emoji/customEmoji';
import { rehypeMentions } from '../utils/rehypeMentions';
import { rehypeHighlightShared } from '../utils/rehypeHighlightShared';
import { isPlainText } from '../utils/plainText';
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
      aria-label="Spoiler, select to reveal"
      onClick={reveal}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(e); } }}
    >
      <span aria-hidden="true">{children}</span>
    </span>
  );
}

// A channel mention (`<#id>`): its icon and current name; clicking opens it. One not known yet
// opens the rest of your guilds (ChannelMentionContext); still unknown (you can't see it, or it's
// gone), it's `#unknown-channel` and does nothing.
function ChannelMention({ id }) {
  const directory = useContext(ChannelMentionContext);
  const navigate = useNavigate();
  const channel = directory?.channels[id];
  const loadAll = directory?.loadAll;
  useEffect(() => {
    if (!channel) loadAll?.();
  }, [channel, loadAll]);
  if (!channel) {
    return <span className="mention channel-mention unknown"><ChannelIcon className="channel-mention-icon" />{UNKNOWN_CHANNEL}</span>;
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
    return <span className={`mention${me ? ' mention-me' : ''}`}>@{mentionName(mentions?.names, id)}</span>;
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

const markdownComponents = { img: MarkdownImage, span: MarkdownSpan };
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

// A webhook's embeds (unless it asked for Discord's SUPPRESS_EMBEDS) and files; nothing for
// anyone else's message. Markdown in embeds is drawn like the message's own text. Memoised
// like MessageMarkdown: an embed can hold a dozen bits of markdown.
const WebhookParts = memo(function WebhookParts({ webhookId, embeds: sent, attachments, flags, rehypePlugins, mentions }) {
  if (!webhookId) return null;
  const renderMarkdown = (text) => (
    <MentionContext.Provider value={mentions}>
      <MarkdownBody text={text} rehypePlugins={rehypePlugins} />
    </MentionContext.Provider>
  );
  const embeds = flags & 4 ? [] : sent ?? [];
  return (
    <>
      <MessageEmbeds embeds={embeds} renderMarkdown={renderMarkdown} />
      {/* Files an embed shows (attachment://…) aren't shown again, as in Discord. */}
      <MessageFiles attachments={attachments} shownElsewhere={embeds.flatMap((e) => [e.image?.url, e.thumbnail?.url])} />
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

// What MessageMarkdown and WebhookParts take from a message (only what they draw, so memo works).
const markdownProps = (msg) => ({ text: msg.plaintext, localAttachments: msg.localAttachments });
const webhookProps = (msg) => ({ webhookId: msg.webhook_id, embeds: msg.embeds, attachments: msg.attachments, flags: msg.flags });

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
        ? <Poll poll={poll} reactions={msg.reactions} userId={user.id} names={reactionNames} sentAt={msg.timestamp} />
        : <MessageMarkdown {...markdownProps(msg)} rehypePlugins={rehypePlugins} mentions={mentions} />}
      <WebhookParts {...webhookProps(msg)} rehypePlugins={rehypePlugins} mentions={mentions} />
    </div>
  );
}

// One message (with its reply snippet, hover menu and inline editor). `grouped`: it follows
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
  onEndPoll,
  reactionNames,
  onOpenActions,
  focusedMsgId,
  canModerate = false,
  canAddReactions = true,
  canPin = false,
  onTogglePin,
  nameColors,
  mentionRoles,
  myRoleIds,
  encrypted = true,
}) {
  const emojiIndex = useEmojiIndex();
  useDateFormat(); // redraws the times when Settings → Date & time changes
  useProfiles(); // and names when someone changes theirs
  // A webhook's message (guilds): its own name and picture as sent, no person behind it.
  const webhook = Boolean(msg.webhook_id);
  const senderName = webhook ? msg.webhook_name : displayName(msg.sender_id, msg.sender_username);
  // A name or avatar opens that person's profile card.
  const profileProps = (id, username) => (onOpenProfile && !webhook ? {
    role: 'button',
    tabIndex: 0,
    onClick: (e) => { e.stopPropagation(); onOpenProfile({ id, username }, e.currentTarget.getBoundingClientRect()); },
    onKeyDown: (e) => { if (e.key === 'Enter') onOpenProfile({ id, username }, e.currentTarget.getBoundingClientRect()); },
  } : {});
  // A picker or menu is open for this message: it stays highlighted with its menu showing.
  const focused = focusedMsgId === msg.id;
  // Mobile: touch and hold opens the message's action sheet (there's no hover there).
  const longPress = useLongPress(() => onOpenActions(msg), { enabled: isMobile && Boolean(onOpenActions) });
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
  const canReact = Boolean(onToggleReaction) && sent;
  const pinned = Boolean(msg.pinned_at);
  // Pinned: a pin by the time (or after the text, without a header).
  const pinMark = pinned ? (
    <FontAwesomeIcon icon={faThumbtack} className="message-pinned" title="Pinned" aria-label="Pinned" />
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
      className={`each-dm-message-wrapper ${msg.sender_id === user.id ? 'sent' : 'received'}${focused ? ' focused' : ''}${mentionsMe ? ' mentioned' : ''}${grouped ? ' grouped' : ''}`}
      data-msg-id={msg.id}
      onMouseEnter={() => setHoveredMsgId(msg.id)}
      onMouseLeave={() => setHoveredMsgId(null)}
      {...longPress}
    >
      {parent && (
        <div className="reply-snippet">
          <Avatar userId={parent.sender_id} alt={displayName(parent.sender_id, parent.sender_username)} className="reply-avatar" />
          <span className="reply-author" style={{ color: nameColors?.[parent.sender_id] }}>{displayName(parent.sender_id, parent.sender_username)}</span>
          <span
            className="reply-preview"
            onClick={() => {
              const el = document.querySelector(
                `[data-msg-id="${msg.parent_message_id}"]`
              );
              if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
          >
            {/* One line (CSS cuts it with "…" where it runs out of room); the start is plenty. */}
            {mentionsToText(customEmojiToText(hideSpoilers(summarizeAttachments(parent.plaintext))), reactionNames, mentionRoles, mentionChannels)
              ?.replace(/\s+/g, ' ').trim().slice(0, 300) || "…"}
          </span>
        </div>
      )}

      {(focusedMsgId ?? hoveredMsgId) === msg.id && !isMobile && (
        <div className="message-menu">
          {canReact && canAddReactions && (
            <button
              className="icon-button"
              aria-label="Add reaction"
              // Keep an open picker's outside-click handler from closing it before this toggles it.
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => onOpenReactionPicker(msg, e.currentTarget)}
            >
              <FontAwesomeIcon icon={faFaceSmile} title="Add reaction" />
            </button>
          )}
          {canPin && sent && onTogglePin && (
            <button className={`icon-button pin-button${pinned ? ' active' : ''}`} onClick={() => onTogglePin(msg)}>
              <FontAwesomeIcon icon={faThumbtack} title={pinned ? 'Unpin' : 'Pin'} />
            </button>
          )}
          {/* A closed poll can't be edited. */}
          {msg.sender_id === user.id && !(poll && pollEnded(poll, msg.timestamp)) && (
            <button className="icon-button" onClick={() => handleEdit(msg)}>
              <FontAwesomeIcon icon={faEdit} title="Edit" />
            </button>
          )}
          <button className="icon-button" onClick={() => handleReply(msg)}>
            <FontAwesomeIcon icon={faReply} title="Reply" />
          </button>
          {(msg.sender_id === user.id || canModerate) && (
            <button
              className="icon-button trash-button"
              // Shift+click deletes without asking (ChatPane).
              onClick={(e) => handleDelete(msg, e)}
            >
              <FontAwesomeIcon icon={faTrash} title="Delete" />
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
          />
        ) : (
          <Avatar
            userId={msg.sender_id}
            alt={senderName}
            className="message-avatar"
            {...profileProps(msg.sender_id, msg.sender_username)}
          />
        )}
        <strong className="message-author" style={{ color: webhook ? undefined : nameColors?.[msg.sender_id] }} {...profileProps(msg.sender_id, msg.sender_username)}>{senderName}</strong>{' '}
        {webhook && <span className="app-tag" title="Posted by a webhook">APP</span>}{webhook && ' '}

        <small>
          <span title={formatDateTime(msg.timestamp * 1000, { seconds: true })}>{formatDateTime(msg.timestamp * 1000)}</span>
          {msg.edited ? <em style={{ marginLeft: '6px' }}>edited</em> : null}
          {pinMark}
          {/* Group DMs: sent before messages were signed (the sender can't be verified), or a
              signature that doesn't match the sender. */}
          {msg.unsigned ? (
            <em className="message-signature unsigned" title="Sent before group messages were signed: who sent it can't be verified">not signed</em>
          ) : null}
          {msg.unverified ? (
            <em className="message-signature unverified" title="The signature doesn't match the sender: it may be forged">⚠ unverified sender</em>
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
                ariaLabel="Edit message"
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
                  Escape to <a href="#" onClick={(e) => { e.preventDefault(); setEditingMessageId(null); }}>cancel</a> • Enter to <a href="#" onClick={(e) => { e.preventDefault(); handleSaveEdit(msg.id); }}>save</a>
                </span>
              </div>
            </div>
          ) : poll ? (
            <Poll
              poll={poll}
              reactions={msg.reactions}
              userId={user.id}
              names={reactionNames}
              sentAt={msg.timestamp}
              onVote={canReact && onVote ? (optionIds) => onVote(msg, optionIds) : undefined}
              onEnd={sent && msg.sender_id === user.id && onEndPoll ? () => onEndPoll(msg) : undefined}
            />
          ) : (
            <MessageMarkdown {...markdownProps(msg)} rehypePlugins={rehypePlugins} mentions={mentions} />
          )}
          {/* Without a header to carry it, "edited" goes after the text. */}
          {grouped && msg.edited && editingMessageId !== msg.id ? <small className="message-edited">(edited)</small> : null}
          {grouped && editingMessageId !== msg.id ? pinMark : null}

          <WebhookParts {...webhookProps(msg)} rehypePlugins={rehypePlugins} mentions={mentions} />

          {!poll && <UrlPreviews text={msg.plaintext} encrypted={encrypted} />}
        </div>

        {canReact && (
          <MessageReactions
            reactions={msg.reactions}
            userId={user.id}
            names={reactionNames}
            onToggle={(emoji) => onToggleReaction(msg, emoji)}
            onAdd={canAddReactions ? (anchor) => onOpenReactionPicker(msg, anchor) : undefined}
          />
        )}

      </div>
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
  onEndPoll,
  onJumpToMessage,
  reactionNames,
  onOpenActions,
  focusedMsgId,
  canModerate,
  canAddReactions,
  canPin,
  onTogglePin,
  nameColors,
  mentionRoles,
  myRoleIds,
  encrypted = true,
}) {
  const scrollerRef = useRef(null);
  const contentRef = useRef(null);
  // Following the newest message (true until the user scrolls away from the bottom).
  const pinnedToBottom = useRef(true);
  // The list's own height when last seen, to tell the list resizing apart from user scrolling.
  const lastListHeight = useRef(null);
  // Manual anchoring only: the first visible row and its position within the content.
  // Scrolling doesn't change that position; content changing above the row does, and that
  // difference is exactly how far to scroll to keep the row still.
  const anchor = useRef(null);

  const latest = useRef({ hasMore, loadMoreMessages });
  latest.current = { hasMore, loadMoreMessages };

  // The profile card open from a name or avatar: { user, anchor (rect) }.
  const [profileFor, setProfileFor] = useState(null);
  const closeProfile = useCallback(() => setProfileFor(null), []);
  const openProfile = useCallback((person, anchor) => setProfileFor({ user: person, anchor }), []);

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
    onEndPoll,
    reactionNames,
    onOpenActions,
    focusedMsgId,
    canModerate,
    canAddReactions,
    canPin,
    onTogglePin,
    nameColors,
    mentionRoles,
    myRoleIds,
    encrypted,
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
  }, [messages, hasMore, user.id, keepAnchorInPlace, rememberAnchor, maybeLoadOlder]);

  // Rows changing size (images/videos loading, code highlighting, edits), and the list itself
  // changing height (keyboard or mobile emoji panel opening). ResizeObserver callbacks run
  // after layout but before paint, so the correction is never seen.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      keepAnchorInPlace();
      rememberAnchor();
      lastListHeight.current = scrollerRef.current?.clientHeight ?? null;
    });
    observer.observe(contentRef.current);
    observer.observe(scrollerRef.current);
    return () => observer.disconnect();
  }, [keepAnchorInPlace, rememberAnchor]);

  return (
    <div
      className={`message-scroller${focusedMsgId != null ? ' has-focused-message' : ''}`}
      ref={scrollerRef}
      onScroll={handleScroll}
    >
      <div className="message-scroller-content" ref={contentRef}>
        {messages.map((msg, i) => (
          <div key={rowKey(msg)} data-key={rowKey(msg)}>
            {startsNewDay(messages[i - 1], msg, { hasMore }) && <DayDivider time={rowTime(msg)} />}
            {/* A poll's result when it closed, a call; group DMs: membership changes, between the messages. */}
            {msg.system === 'poll_end'
              ? <PollEndNotice msg={msg} onJump={onJumpToMessage} />
              : msg.system === 'call'
              ? <CallLogNotice msg={msg} meId={user?.id} />
              : msg.system
              ? <p className="message-system">{msg.text}</p>
              : <MessageRow msg={msg} grouped={continuesGroup(messages[i - 1], msg)} {...rowProps} />}
          </div>
        ))}
      </div>
      {profileFor && <ProfilePopover user={profileFor.user} anchor={profileFor.anchor} onClose={closeProfile} />}
    </div>
  );
}
