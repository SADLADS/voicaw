import React, { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trans } from 'react-i18next';
import { ConfigContext, InteractionContext } from '../contexts';
import { customEmojiUrl, parseCustomEmoji } from '../emoji/customEmoji';
import { useEmojiIndex } from '../emoji/emojiContext';
import { emojiImageUrl } from '../emoji/emojiIndex';
import { groupReactions, reactionShortName } from '../utils/reactions';
import { useLongPress } from '../hooks/useLongPress';
import ReactionsDialog from './ReactionsDialog';
import { t } from '../i18n';

// A reaction's emoji: Unicode (as Twemoji), or a custom emoji's image (`:name:` if deleted).
// Poll answers' emoji too.
export function ReactionEmoji({ native }) {
  const index = useEmojiIndex();
  const { s3Endpoint } = useContext(ConfigContext);
  const [failed, setFailed] = useState(false);
  const custom = parseCustomEmoji(native);
  if (custom) {
    const src = customEmojiUrl(custom.id, s3Endpoint);
    if (failed || !src) return <span className="reaction-native">:{custom.name}:</span>;
    return <img className="emoji" src={src} alt={`:${custom.name}:`} title={`:${custom.name}:`} draggable={false} onError={() => setFailed(true)} />;
  }
  const match = index?.byNative.get(native);
  if (!match) return <span className="reaction-native">{native}</span>;
  return <img className="emoji" src={emojiImageUrl(match.skin.unified)} alt={native} draggable={false} />;
}

// How many people the hover card names before "and N others".
const NAMED = 3;
// Hovering a chip this long shows its card; leaving the chip (or the card) hides it after
// HIDE_MS, so the pointer can cross the gap onto the card to click it.
const SHOW_MS = 250;
const HIDE_MS = 150;
const GAP_PX = 6;
const EDGE_PX = 8;

// "Otto, Harry and Isaac", names bold; "Otto, Harry, Isaac" when `more` follow ("and 275
// others").
function NameList({ names, more }) {
  return names.map((name, i) => (
    <React.Fragment key={i}>
      {i > 0 && (i === names.length - 1 && !more ? t('chat.reactions.lastSeparator') : t('chat.reactions.separator'))}
      <strong>{name}</strong>
    </React.Fragment>
  ));
}

// Discord's card over a hovered reaction: the emoji big, and ":pog: reacted by Otto, Harry,
// Isaac and 275 others". Fixed over the chip (`rect`), below it when there's no room above;
// clicking it opens the breakdown of every reaction.
function ReactionCard({ group, rect, nameOf, onOpen, onEnter, onLeave }) {
  const index = useEmojiIndex();
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(EDGE_PX, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - EDGE_PX));
    const above = rect.top - GAP_PX - height;
    setPos({ left, top: above >= EDGE_PX ? above : rect.bottom + GAP_PX });
  }, [rect, group.userIds.length]);

  const short = reactionShortName(group.emoji, index);
  const emoji = short ? `:${short}:` : group.emoji;
  const named = group.userIds.slice(0, NAMED).map(nameOf);
  const others = group.userIds.length - named.length;
  const components = { emoji: <span className="reaction-card-name" />, names: <NameList names={named} more={others > 0} /> };

  return createPortal(
    <button
      ref={ref}
      type="button"
      className="reaction-card"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onOpen}
    >
      <span className="reaction-card-emoji"><ReactionEmoji native={group.emoji} /></span>
      <span className="reaction-card-text">
        {others > 0
          ? <Trans i18nKey="chat.reactions.cardOthers" count={others} values={{ emoji, count: others }} components={components} />
          : <Trans i18nKey="chat.reactions.card" values={{ emoji }} components={components} />}
      </span>
    </button>,
    document.body
  );
}

// Discord-style reaction chips under a message: tap one to add or remove your own, `+` to
// pick another. `names` maps user id -> username, for the hover card and the breakdown.
// Hovering a chip (with a mouse) shows who reacted; clicking that card, or holding a chip on a
// phone, opens ReactionsDialog: who reacted with each emoji.
// Without `onAdd` (not allowed to react), there's no "+" and only your own chips can be tapped
// (to take your reaction back).
export default function MessageReactions({ reactions, userId, names, onToggle, onAdd }) {
  const { isMobile } = useContext(InteractionContext);
  const groups = groupReactions(reactions);
  const [hover, setHover] = useState(null); // { emoji, rect }
  const [dialog, setDialog] = useState(null); // the emoji its first tab is
  const showTimer = useRef(null);
  const hideTimer = useRef(null);

  const clearTimers = () => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
  };
  useEffect(() => clearTimers, []);

  // A fixed card would drift away from its chip as the messages scroll.
  useEffect(() => {
    if (!hover) return undefined;
    const hide = () => setHover(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [hover]);

  const held = useRef(false);
  const press = useLongPress((target) => {
    const chip = target?.closest?.('[data-reaction]');
    if (!chip) return;
    held.current = true;
    setDialog(chip.dataset.reaction);
  }, { enabled: isMobile });
  const closeDialog = useCallback(() => setDialog(null), []);

  if (groups.length === 0 && !dialog) return null;

  const nameOf = (id) => names?.[id] ?? (id === userId ? t('chat.reactions.you') : t('chat.reactions.someone'));
  const hovered = hover && groups.find((g) => g.emoji === hover.emoji);

  const enterChip = (e, emoji) => {
    if (e.pointerType !== 'mouse') return;
    clearTimers();
    const rect = e.currentTarget.getBoundingClientRect();
    // From one chip straight to the next, the card follows at once.
    if (hover) setHover({ emoji, rect });
    else showTimer.current = setTimeout(() => setHover({ emoji, rect }), SHOW_MS);
  };
  const leave = () => {
    clearTimers();
    hideTimer.current = setTimeout(() => setHover(null), HIDE_MS);
  };
  const stop = (e) => e.stopPropagation(); // not the message's own click handling

  return (
    <div
      className="message-reactions"
      {...press}
      // Holding a chip is about the reaction, not the message: the row's own long press (the
      // action sheet) mustn't start too.
      onTouchStart={(e) => {
        if (!isMobile || !e.target.closest?.('[data-reaction]')) return;
        e.stopPropagation();
        held.current = false;
        press.onTouchStart(e);
      }}
      // Lifting the finger after a hold mustn't send the mouse events that follow a tap: they'd
      // land on the breakdown's backdrop, which closes it.
      onTouchEnd={(e) => {
        press.onTouchEnd?.(e);
        if (held.current) {
          held.current = false;
          e.preventDefault();
        }
      }}
      // Only the row's own clicks (the tap ending a hold): not those in the portalled
      // breakdown, which React passes through here too.
      onClickCapture={(e) => {
        if (e.currentTarget.contains(e.target)) press.onClickCapture?.(e);
      }}
      onTouchCancel={(e) => {
        press.onTouchCancel?.(e);
        held.current = false;
      }}
    >
      {groups.map(({ emoji, userIds }) => {
        const mine = userIds.includes(userId);
        const who = userIds.map((id) => (id === userId ? t('chat.reactions.you') : names?.[id] ?? t('chat.reactions.someone'))).join(', ');
        const locked = !mine && !onAdd;
        return (
          <button
            key={emoji}
            type="button"
            data-reaction={emoji}
            className={`reaction-chip${mine ? ' mine' : ''}${locked ? ' locked' : ''}`}
            aria-pressed={mine}
            aria-label={t('chat.reactions.chipLabel', { emoji, number: userIds.length, names: who })}
            // Not `disabled`: it still shows who reacted when hovered or held.
            aria-disabled={locked || undefined}
            onPointerEnter={(e) => enterChip(e, emoji)}
            onPointerLeave={leave}
            onClick={() => { if (!locked) onToggle(emoji); }}
          >
            <ReactionEmoji native={emoji} />
            <span className="reaction-count">{userIds.length}</span>
          </button>
        );
      })}
      {onAdd && <button
        type="button"
        className="reaction-chip reaction-add"
        aria-label={t('chat.reactions.add')}
        title={t('chat.reactions.add')}
        // Keep the open picker's outside-click handler from closing it before this toggles it.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => onAdd(e.currentTarget)}
      >
        +
      </button>}
      {/* Portalled out of the message, but React still passes their events up to it: a long
          press or right-click in them mustn't open the message's actions. */}
      {hovered && !dialog && (
        <span onContextMenu={stop} onClick={stop}>
          <ReactionCard
            group={hovered}
            rect={hover.rect}
            nameOf={nameOf}
            onEnter={clearTimers}
            onLeave={leave}
            onOpen={() => { clearTimers(); setHover(null); setDialog(hovered.emoji); }}
          />
        </span>
      )}
      {dialog && (
        <span onTouchStart={stop} onTouchEnd={stop} onContextMenu={stop} onClick={stop}>
          <ReactionsDialog
            groups={groups}
            names={names}
            userId={userId}
            initialEmoji={dialog}
            onRemove={onToggle}
            onClose={closeDialog}
          />
        </span>
      )}
    </div>
  );
}
