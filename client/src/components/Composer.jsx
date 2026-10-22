import React, { useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { Icon } from './Icon';
import { faCheck, faClock, faComments, faFaceSmile, faKeyboard, faMicrophone, faPaperPlane, faPlus, faSquarePollHorizontal, faUpload } from '@fortawesome/free-solid-svg-icons';
import AttachPanel from './AttachPanel';
import EmojiPicker from './EmojiPicker';
import EmojiSuggestions from './EmojiSuggestions';
import MentionSuggestions from './MentionSuggestions';
import CommandSuggestions from './CommandSuggestions';
import CommandComposer from './CommandComposer';
import { useChannelCommands } from '../hooks/useChannelCommands';
import { commandEntries, groupCommandsByBot, searchCommands } from '../utils/commandOptions';
import AttachmentTray from './AttachmentTray';
import '../assets/css/commands.css';
import FileDropOverlay from './FileDropOverlay';
import PollDialog from './PollDialog';
import TimestampDialog from './TimestampDialog';
import VoiceRecorderBar, { MicButton } from './VoiceRecorder';
import { useEmojiIndex } from '../emoji/emojiContext';
import { getSkinTone, recordEmojiUse, skinFor } from '../emoji/emojiUsage';
import { getKeyboardHeight } from '../utils/keyboardHeight';
import { findPlaceholderIds, makePlaceholder, replacePlaceholders } from '../utils/attachmentMarkup';
import { seedAttachmentCache } from '../services/attachmentCache';
import { useAttachmentDrafts } from '../hooks/useAttachmentDrafts';
import { useWindowFileDrop } from '../hooks/useFileDrop';
import { useVoiceRecording } from '../hooks/useVoiceRecording';
import { useBackClosesWhile } from '../hooks/useBackCloses';
import MessageEditor from '../editor/MessageEditor';
import {
  customEmojiByName,
  customEmojiUrl,
  customUsageId,
  parseCustomEmoji,
  searchCustomEmoji,
} from '../emoji/customEmoji';
import { useCustomEmoji } from '../emoji/customEmojiContext';
import { searchChannels, searchMentions } from '../utils/mentions';
import { gifMarkup } from '../utils/gifMarkup';
import { displayName, nameOf, useProfiles } from '../utils/profiles';
import { noteTyping, typingDone } from '../services/typingService';
import { getDraft, saveDraft } from '../services/draftStore';
import { t } from '../i18n';

// ":smi" right after a space/bracket or at the start (so not "12:30" or "https://").
const EMOJI_QUERY = /(?:^|[\s([{])(:[a-z0-9_+-]{2,})$/i;
// A complete ":shortcode:" just typed.
const EMOJI_SHORTCODE = /(?:^|[\s([{]):([a-z0-9_+-]+):$/i;
// "@", "@na": a mention being typed (not "a@b").
const MENTION_QUERY = /(?:^|[\s([{])@([^\s@<>]{0,32})$/;
// "#", "#gen": a channel being typed (not "a#b").
const CHANNEL_QUERY = /(?:^|[\s([{])#([^\s#<>]{0,100})$/;
// "/", "/we": a bot command being picked (the whole message so far).
const COMMAND_QUERY = /^\/([^\s/]{0,32})$/;

// The message box under a conversation (MessageEditor: `inputRef` is its handle), writing to
// `chatName` (a person, or "#channel"; null while the chat can't be sent to yet), with
// attachments (chips in the box, uploaded on send; files can be dropped anywhere on the window) and polls (both from the + menu), emoji (picker, ":smi" suggestions,
// ":shortcode:" conversion), mentions ("@na" suggestions from `people`, [{ id, username }];
// in a guild also `roles`, [{ id, name, color }], and @everyone/@here with `canMentionEveryone`;
// `roleInfo` ({ id: { name, color } }) draws role mentions in the box), channel mentions in a
// guild ("#gen" suggestions from `channels`, [{ id, name, type, private, category }]) and the
// reply bar. What's typed is kept per conversation while the app is open (draftStore).
// In a guild channel or thread (`commandChannelId`), "/" at the start lists its bots' commands
// (CommandSuggestions); picking one turns the box into CommandComposer until it's run or left.
//
// `textOnly` (a bot DM) takes away the + menu and files pasted or dropped: text and emoji only.
// Voice messages (useVoiceRecording, VoiceRecorder): on a phone the mic button in Send's place
// while the box is empty (hold to record), on a computer the + menu's Voice message; either
// way the box gives way to the recording until it's sent (its own message) or deleted.
// The + button: a menu on a computer (upload a file, create a poll, create a thread, voice
// message, timestamps), on a phone a panel in the keyboard's place (AttachPanel: camera, the
// phone's photos, then the same and the photo picker). Timestamps (TimestampDialog) puts a
// `<t:unix:style>` in the box, shown as it will read. `onStartThread` (a guild text channel you may start threads in)
// opens the new thread dialog.
// `onSend({ text, replyTo, localAttachments, resolveText })` sends (see useConversation's
// sendMessage); `onSendPoll({ poll, replyTo })` sends a poll made in PollDialog (see ChatPane).
// `error` is shown above the box (Dm reports its own errors there too). On
// mobile the emoji panel (`showEmojiPicker`) takes the keyboard's place; `onInputFocus`
// runs when the keyboard is about to come up. Opening a conversation focuses the box on a
// computer (not on a phone: that would open the keyboard), unless `focusOnOpen` is false.
// Phone: `editing` (a message) puts its text in the box to be changed, under an "Editing
// message" bar; Send calls `onSaveEdit(text)` (throws if it couldn't), the bar's × calls
// `onCancelEdit()`. Either way the box is emptied after, the keyboard staying up.
export default function Composer({
  chatId,
  chatName,
  isMobile,
  maxPlaintextLength,
  s3Endpoint,
  inputRef,
  replyTo,
  onCancelReply,
  editing = null,
  onSaveEdit,
  onCancelEdit,
  error,
  setError,
  showEmojiPicker,
  setShowEmojiPicker,
  onInputFocus,
  onSend,
  onSendPoll,
  onStartThread = null,
  people,
  roles,
  roleInfo,
  canMentionEveryone = false,
  channels,
  chatTexts,
  commandChannelId = null,
  focusOnOpen = true,
  textOnly = false,
}) {
  // What the box and the file drop overlay say: "Message Alice", or the chat's own wording
  // (`chatTexts`: { label, placeholder, upload }, e.g. a document's replies).
  const name = chatName || t('chat.composer.fallbackName');
  const texts = chatTexts ?? {
    label: t('chat.composer.messageLabel', { name }),
    placeholder: t('chat.composer.messagePlaceholder', { name }),
    upload: t('media.fileDrop.title', { name }),
  };
  const emojiIndex = useEmojiIndex();
  useProfiles();
  const mentionNames = Object.fromEntries((people ?? []).map((p) => [p.id, nameOf(p)]));
  const custom = useCustomEmoji();
  // What the editor needs to show a custom emoji.
  const customNode = (emoji) => ({ id: String(emoji.id), name: emoji.name, url: customEmojiUrl(emoji.id, s3Endpoint) });
  // The message as text (see editor/messageDoc), and its current line up to the cursor
  // (which drives ":smi" suggestions).
  const [inputValue, setInputValue] = useState('');
  const [beforeCaret, setBeforeCaret] = useState('');
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  // The query (":smi" or "@na") whose suggestions Escape closed.
  const [dismissedQuery, setDismissedQuery] = useState(null);
  // The + button's menu (upload a file, create a poll...), the poll dialog and the timestamp one.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [creatingPoll, setCreatingPoll] = useState(false);
  const [addingTimestamp, setAddingTimestamp] = useState(false);
  const addMenuRef = useRef(null);
  // Mobile: the + panel, which takes turns with the keyboard and the emoji panel.
  const [showAttachPanel, setShowAttachPanel] = useState(false);
  // The conversation the box's text is saved for, and whether its draft is being put back.
  const draftChatId = useRef(chatId);
  // Bot commands (guild channels only), and the one being filled in (command mode).
  const { commands, refresh: refreshCommands } = useChannelCommands(commandChannelId, { enabled: commandChannelId != null });
  const [commandEntry, setCommandEntry] = useState(null);
  const restoringDraft = useRef(false);
  // The conversation an edit (`editing`) started in, while there is one.
  const editingIn = useRef(null);

  // Emoji from the picker (Unicode, or `<:name:id>`). On mobile the box isn't focused (that
  // would open the keyboard).
  function insertEmoji(text) {
    const customEmoji = parseCustomEmoji(text);
    if (customEmoji) inputRef.current?.insertCustomEmoji(customNode(customEmoji), { focus: !isMobile });
    else inputRef.current?.insertText(text, { focus: !isMobile });
  }

  const attachments = useAttachmentDrafts({
    chatId,
    s3Endpoint,
    // Mobile: not focused (as emoji), so the + panel stays open for more and the keyboard down.
    insertAttachments: (drafts) => inputRef.current?.insertAttachments(drafts, { focus: !isMobile }),
    onError: setError,
    onDiscard: (dropped) => {
      dropped.forEach((d) => inputRef.current?.removeAttachment(d.id));
      setError(null);
    },
  });

  // Voice messages: what's being recorded, and (a phone's hold) how far the finger slid left.
  const voice = useVoiceRecording({ onSend: sendVoice, onError: setError, resetKey: chatId, stopWhenHidden: isMobile });
  const [voiceDragX, setVoiceDragX] = useState(0);
  const canRecord = !textOnly && !editing && !!chatName
    && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  // Files dragged in anywhere on the window are attached (FileDropOverlay while dragging).
  const draggingFiles = useWindowFileDrop({ enabled: !!chatName && !textOnly, onFiles: attachments.addFiles });

  function removeDraft(id) {
    attachments.removeDraft(id);
    inputRef.current?.removeAttachment(id);
  }

  // On mobile the emoji panel and the on-screen keyboard take turns in the same space (like
  // Discord): opening the panel dismisses the keyboard, and the button (then showing a
  // keyboard) or tapping the message box swaps back.
  function toggleEmojiPicker() {
    if (isMobile) {
      if (showEmojiPicker) {
        setShowEmojiPicker(false);
        inputRef.current?.focus(); // inside the tap, so the keyboard opens
      } else {
        inputRef.current?.blur();
        setShowAttachPanel(false);
        setShowEmojiPicker(true);
      }
      return;
    }
    setShowEmojiPicker(!showEmojiPicker);
  }

  // The + button: on mobile the panel swaps with the keyboard (as the emoji panel does).
  function toggleAdd() {
    if (!isMobile) {
      setAddMenuOpen(!addMenuOpen);
      return;
    }
    if (showAttachPanel) {
      setShowAttachPanel(false);
      inputRef.current?.focus();
    } else {
      inputRef.current?.blur();
      setShowEmojiPicker(false);
      setShowAttachPanel(true);
    }
  }

  // A photo picked in the + panel and tapped again: taken back out of the message.
  function removePicked(source) {
    const draft = attachments.drafts.find((d) => d.source === source);
    if (draft) removeDraft(draft.id);
  }

  const emojiQuery = emojiIndex ? EMOJI_QUERY.exec(beforeCaret)?.[1] ?? null : null;
  // Custom emoji first, then standard ones (8 in all).
  const emojiSuggestions = emojiQuery && emojiQuery !== dismissedQuery
    ? [...searchCustomEmoji(custom, emojiQuery.slice(1), 8), ...emojiIndex.search(emojiQuery.slice(1), 8)].slice(0, 8)
    : [];
  const mentionQuery = people?.length ? MENTION_QUERY.exec(beforeCaret)?.[1] ?? null : null;
  const mentionSuggestions = mentionQuery != null && `@${mentionQuery}` !== dismissedQuery
    ? searchMentions({ people, roles, everyone: canMentionEveryone }, mentionQuery)
    : [];
  const channelQuery = channels?.length ? CHANNEL_QUERY.exec(beforeCaret)?.[1] ?? null : null;
  const channelSuggestions = channelQuery != null && `#${channelQuery}` !== dismissedQuery
    ? searchChannels(channels, channelQuery)
    : [];
  const commandQuery = commandChannelId != null && !editing && inputValue === beforeCaret ? COMMAND_QUERY.exec(beforeCaret)?.[1] ?? null : null;
  const commandSuggestions = commandQuery != null && `/${commandQuery}` !== dismissedQuery
    ? groupCommandsByBot(searchCommands(commandEntries(commands), commandQuery, Infinity)).flatMap((s) => s.entries)
    : [];
  // Only one kind can match what's before the cursor.
  const suggestions = commandSuggestions.length > 0 ? commandSuggestions
    : emojiSuggestions.length > 0 ? emojiSuggestions
    : mentionSuggestions.length > 0 ? mentionSuggestions : channelSuggestions;
  const activeSuggestion = Math.min(suggestionIndex, Math.max(suggestions.length - 1, 0));

  function pickSuggestion(item) {
    if (commandSuggestions.length > 0) pickCommand(item);
    else if (emojiSuggestions.length > 0) pickEmoji(item);
    else if (item.kind === 'channel') pickChannel(item);
    else pickMention(item);
  }

  // A command picked: the "/…" typed goes, and the box becomes its form.
  function pickCommand(entry) {
    inputRef.current?.clear();
    typingDone(chatId);
    setSuggestionIndex(0);
    setCommandEntry(entry);
  }

  function leaveCommand() {
    setCommandEntry(null);
    queueMicrotask(() => inputRef.current?.focus());
  }

  function pickChannel(item) {
    inputRef.current?.replaceBeforeCaretWithChannelMention(channelQuery.length + 1, { id: item.id, name: item.name });
    setSuggestionIndex(0);
  }

  function pickMention(item) {
    const count = mentionQuery.length + 1;
    const editor = inputRef.current;
    if (item.kind === 'role') editor?.replaceBeforeCaretWithRoleMention(count, { id: item.id, name: item.name, color: roleInfo?.[item.id]?.color });
    else if (item.kind === 'everyone') editor?.replaceBeforeCaret(count, `@${item.name} `);
    else editor?.replaceBeforeCaretWithMention(count, { id: item.id, name: item.name });
    setSuggestionIndex(0);
  }

  function pickEmoji(emoji) {
    if (emoji.guild) {
      recordEmojiUse(customUsageId(emoji.id));
      inputRef.current?.replaceBeforeCaretWithCustomEmoji(emojiQuery.length, customNode(emoji));
    } else {
      recordEmojiUse(emoji.id);
      inputRef.current?.replaceBeforeCaret(emojiQuery.length, `${skinFor(emoji, getSkinTone()).native} `);
    }
    setSuggestionIndex(0);
  }

  function handleEditorChange({ text, beforeCaret: line, docChanged }) {
    setInputValue(text);
    setBeforeCaret(line);
    if (!docChanged) return;
    // The message being edited isn't a draft, nor typing.
    if (editingIn.current != null) return;
    saveDraft(draftChatId.current, text);
    // Putting a draft back isn't typing.
    if (restoringDraft.current) return;
    if (text.trim()) noteTyping(chatId);
    else typingDone(chatId);
    setSuggestionIndex(0);

    // Typing the closing colon of a known :shortcode: turns it into the emoji (like Discord):
    // a standard one, else a custom emoji of that name.
    const typed = emojiIndex && EMOJI_SHORTCODE.exec(line);
    const emoji = typed && emojiIndex.byShortcode.get(typed[1].toLowerCase());
    const customEmoji = typed && !emoji && customEmojiByName(custom, typed[1]);
    if (customEmoji) {
      recordEmojiUse(customUsageId(customEmoji.id));
      queueMicrotask(() => {
        const editor = inputRef.current;
        if (editor && !editor.isComposing()) {
          editor.replaceBeforeCaretWithCustomEmoji(typed[1].length + 2, customNode(customEmoji), { focus: false });
        }
      });
    }
    if (emoji) {
      recordEmojiUse(emoji.id);
      const native = skinFor(emoji, getSkinTone()).native;
      // After this edit has finished (and not in the middle of a keyboard's composition).
      queueMicrotask(() => {
        const editor = inputRef.current;
        if (editor && !editor.isComposing()) editor.replaceBeforeCaret(typed[1].length + 2, native, { focus: false });
      });
    }
  }

  function handleInputKeyDown(e) {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setSuggestionIndex((activeSuggestion + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickSuggestion(suggestions[activeSuggestion]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedQuery(commandSuggestions.length > 0 ? `/${commandQuery}` : emojiSuggestions.length > 0 ? emojiQuery
          : mentionSuggestions.length > 0 ? `@${mentionQuery}` : `#${channelQuery}`);
        return;
      }
    }
  }

  async function handleSubmit(e) {
    e?.preventDefault();
    const text = (inputRef.current?.getText() ?? '').trim();
    if (editing) {
      await saveEdit(text);
      return;
    }
    if (!text || !chatName) return;

    const referencedIds = findPlaceholderIds(text);
    const referenced = attachments.drafts.filter((d) => referencedIds.has(d.id));

    // Placeholders are much shorter than the final attachment URLs, so check the length
    // the message will have once they're swapped in.
    const projectedText = replacePlaceholders(
      text,
      Object.fromEntries(referenced.map((d) => [d.id, attachments.projectedUrl(d)]))
    );
    if (projectedText.length > maxPlaintextLength) {
      setError(t('chat.composer.tooLongWithLinks', { count: projectedText.length - maxPlaintextLength }));
      return;
    }
    setError(null);

    inputRef.current?.clear();
    typingDone(chatId);
    const sending = attachments.takeDrafts(referencedIds);
    onCancelReply();

    try {
      await onSend({
        text,
        replyTo,
        // Lets the pending message show attachments from the local files while they upload.
        localAttachments: Object.fromEntries(
          sending.map((d) => [
            d.id,
            { previewUrl: d.previewUrl, type: d.type, size: d.size, width: d.width, height: d.height, spoiler: !!d.spoiler },
          ])
        ),
        resolveText: sending.length > 0 ? async () => {
          const urls = await attachments.upload(sending);
          sending.forEach((d) => seedAttachmentCache(urls[d.id], d.previewUrl));
          return replacePlaceholders(text, urls);
        } : undefined,
      });
    } catch (err) {
      setError(t('chat.composer.sendFailed', { error: err.message }));
    }
  }

  // Emptied (or only whitespace left): the same as cancelling.
  async function saveEdit(text) {
    if (!text) {
      onCancelEdit();
      return;
    }
    setError(null);
    try {
      await onSaveEdit(text);
    } catch (err) {
      console.error('Failed to edit message', err);
      setError(t('chat.composer.editFailed', { error: err.message }));
    }
  }

  // Starting an edit puts the message in the box, ready to type (the keyboard comes up);
  // ending it empties the box, unless the conversation changed meanwhile (its draft is there).
  const editingId = editing?.id ?? null;
  useEffect(() => {
    const editor = inputRef.current;
    if (!editor) return;
    if (editingId != null) {
      editingIn.current = chatId;
      editor.setText(editing.plaintext ?? '');
      editor.focus();
    } else if (editingIn.current != null) {
      const sameChat = editingIn.current === draftChatId.current;
      editingIn.current = null;
      if (sameChat) editor.clear();
    }
    // Only when another message starts or stops being edited, not when this one changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  // A GIF from the picker goes straight out as its own message (like Discord), replying if a
  // reply is set up; whatever is typed in the box stays there.
  async function sendGif(gif) {
    if (!chatName) return;
    setError(null);
    onCancelReply();
    try {
      await onSend({ text: gifMarkup(gif), replyTo });
    } catch (err) {
      setError(t('chat.composer.gifFailed', { error: err.message }));
    }
  }

  // A recorded voice message goes out as its own message (as Discord's), replying if a reply is
  // set up; whatever is typed stays in the box. `take` is useVoiceRecording's.
  async function sendVoice(take) {
    if (!chatName) return;
    const draft = attachments.voiceDraft(take.file, { duration: take.duration, waveform: take.waveform, previewUrl: take.url });
    const text = makePlaceholder(draft.id, draft.name);
    if (replacePlaceholders(text, { [draft.id]: attachments.projectedUrl(draft) }).length > maxPlaintextLength) {
      setError(t('media.voice.tooLong'));
      return;
    }
    setError(null);
    onCancelReply();
    try {
      await onSend({
        text,
        replyTo,
        localAttachments: {
          [draft.id]: { previewUrl: draft.previewUrl, type: draft.type, size: draft.size, duration: draft.duration, waveform: draft.waveform, voice: true },
        },
        resolveText: async () => {
          const urls = await attachments.upload([draft]);
          seedAttachmentCache(urls[draft.id], draft.previewUrl);
          return replacePlaceholders(text, urls);
        },
      });
    } catch (err) {
      setError(t('chat.composer.sendFailed', { error: err.message }));
    }
  }

  // A poll goes out as its own message, replying if a reply is set up (like a GIF). The dialog
  // stays open (showing the error) if it can't be sent.
  async function sendPoll(poll) {
    await onSendPoll({ poll, replyTo });
    onCancelReply();
  }

  // Opening a conversation puts back what was left typed in it (after the previous one's
  // attachments have gone, see useAttachmentDrafts).
  useEffect(() => {
    draftChatId.current = chatId;
    const editor = inputRef.current;
    const draft = getDraft(chatId);
    if (!editor || editor.getText() === draft) return;
    restoringDraft.current = true;
    try {
      editor.setText(draft);
    } finally {
      restoringDraft.current = false;
    }
  }, [chatId, inputRef]);

  // Ready to type in a conversation just opened, unless another text box has the focus (a
  // search left open after jumping to a result).
  useEffect(() => {
    if (isMobile || !focusOnOpen) return;
    const active = document.activeElement;
    const editor = inputRef.current?.element;
    const typing = active && active !== editor && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
    if (!typing) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Opening the "/" list asks for the channel's commands again (they may have changed).
  const commandListOpen = commandQuery != null;
  useEffect(() => {
    if (commandListOpen) refreshCommands({ fresh: true });
  }, [commandListOpen, refreshCommands]);

  // Another conversation: out of command mode, the + panel closed.
  useEffect(() => {
    setCommandEntry(null);
    setShowAttachPanel(false);
  }, [chatId]);

  // The + menu closes on a click outside it or Escape.
  useEffect(() => {
    if (!addMenuOpen) return undefined;
    const onDown = (e) => {
      if (!addMenuRef.current?.contains(e.target)) setAddMenuOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setAddMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [addMenuOpen]);

  // Escape cancels a reply (not while it's closing a dialog or deleting a recording).
  useEffect(() => {
    if (creatingPoll || addingTimestamp || voice.active) return undefined;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      onCancelReply();
      if (editingId != null) onCancelEdit?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancelReply, onCancelEdit, editingId, creatingPoll, addingTimestamp, voice.active]);

  // The tray only shows drafts still referenced from the text; unreferenced ones are kept
  // until send so that undoing a deletion brings them back.
  const referencedDraftIds = findPlaceholderIds(inputValue);
  const visibleDrafts = attachments.drafts.filter((d) => referencedDraftIds.has(d.id));
  const pickedSources = visibleDrafts.filter((d) => d.source != null).map((d) => d.source);
  const attachPanelOpen = showAttachPanel && isMobile && !textOnly && !editing;
  // Phone: the panels in the keyboard's place are an entry in history, so Back (and swiping to
  // the list, which goes back past it) closes them rather than leaving the chat.
  useBackClosesWhile(isMobile && (attachPanelOpen || showEmojiPicker), () => {
    setShowAttachPanel(false);
    setShowEmojiPicker(false);
  }, 'voicawComposerPanel');
  // A phone's mic button takes Send's place while there's nothing to send (as in Discord).
  const showMic = isMobile && canRecord && (voice.active ? !voice.locked : !inputValue.trim());

  return (
    <>
      {draggingFiles && <FileDropOverlay title={texts.upload} />}
      <div className="dm-chat-wrapper">
        {showEmojiPicker && !isMobile && (
          <EmojiPicker onSelect={insertEmoji} onGif={sendGif} onClose={() => setShowEmojiPicker(false)} />
        )}

        {commandSuggestions.length > 0 && !commandEntry && (
          <CommandSuggestions
            query={commandQuery}
            entries={commandSuggestions}
            activeIndex={activeSuggestion}
            onPick={pickCommand}
            onHover={setSuggestionIndex}
          />
        )}

        {emojiSuggestions.length > 0 && commandSuggestions.length === 0 && (
          <EmojiSuggestions
            query={emojiQuery}
            emojis={emojiSuggestions}
            activeIndex={activeSuggestion}
            onPick={pickEmoji}
            onHover={setSuggestionIndex}
            s3Endpoint={s3Endpoint}
          />
        )}

        {mentionSuggestions.length > 0 && emojiSuggestions.length === 0 && (
          <MentionSuggestions
            query={mentionQuery}
            items={mentionSuggestions}
            activeIndex={activeSuggestion}
            onPick={pickMention}
            onHover={setSuggestionIndex}
            s3Endpoint={s3Endpoint}
          />
        )}

        {channelSuggestions.length > 0 && mentionSuggestions.length === 0 && emojiSuggestions.length === 0 && (
          <MentionSuggestions
            symbol="#"
            query={channelQuery}
            items={channelSuggestions}
            activeIndex={activeSuggestion}
            onPick={pickChannel}
            onHover={setSuggestionIndex}
          />
        )}

        {editing && (
          <div className="reply-bar">
            <span>{t('chat.composer.editingMessage')}</span>
            <button
              className="reply-close"
              type="button"
              aria-label={t('chat.composer.stopEditing')}
              // The message box keeps focus, so the keyboard stays up.
              onMouseDown={(e) => e.preventDefault()}
              onClick={onCancelEdit}
            >
              ×
            </button>
          </div>
        )}

        {replyTo && (
          <div className="reply-bar">
            <span>
              <Trans i18nKey="chat.composer.replyingTo" values={{ name: displayName(replyTo.sender_id, replyTo.sender_username) }} components={{ b: <strong /> }} />
            </span>
            <button className="reply-close" onClick={onCancelReply} type="button">
              ×
            </button>
          </div>
        )}

        {error && (
          <div className="composer-error" role="alert">
            <span>{error}</span>
            <button className="reply-close" onClick={() => setError(null)} type="button">
              ×
            </button>
          </div>
        )}

        <AttachmentTray drafts={visibleDrafts} onRemove={removeDraft} onToggleSpoiler={attachments.toggleSpoiler} />

        {commandEntry && (
          <CommandComposer
            key={commandEntry.key}
            entry={commandEntry}
            channelId={commandChannelId}
            people={people}
            roleInfo={roleInfo}
            channels={channels}
            onClose={leaveCommand}
          />
        )}

        {/* Kept (hidden) in command mode, so what's typed and the editor survive it. */}
        <form id="dm-chat-form" className={commandEntry ? 'd-none' : 'd-flex flex-grow-1'} hidden={Boolean(commandEntry)} onSubmit={handleSubmit}>
          {!textOnly && !editing && !voice.active && <div className="attach-wrapper" ref={addMenuRef}>
            <button
              className="attach-button"
              type="button"
              aria-label={t('common.add')}
              aria-haspopup={isMobile ? 'dialog' : 'menu'}
              aria-expanded={isMobile ? attachPanelOpen : addMenuOpen}
              // Mobile: the box keeps the keyboard's state until toggleAdd decides, and the emoji
              // panel's outside-click handler doesn't close it first (the button would drop
              // away from under the finger before the click).
              onMouseDown={isMobile ? (e) => { e.preventDefault(); e.stopPropagation(); } : undefined}
              onClick={toggleAdd}
            >
              <Icon icon={faPlus} />
            </button>
            {addMenuOpen && (
              <div className="composer-add-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="composer-add-item"
                  onClick={() => { setAddMenuOpen(false); attachments.pickFiles(); }}
                >
                  <Icon icon={faUpload} fixedWidth /> {t('chat.composer.uploadFile')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="composer-add-item"
                  disabled={!chatName}
                  onClick={() => { setAddMenuOpen(false); setCreatingPoll(true); }}
                >
                  <Icon icon={faSquarePollHorizontal} fixedWidth /> {t('chat.composer.createPoll')}
                </button>
                {onStartThread && (
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-add-item"
                    onClick={() => { setAddMenuOpen(false); onStartThread(); }}
                  >
                    <Icon icon={faComments} fixedWidth /> {t('chat.composer.createThread')}
                  </button>
                )}
                {canRecord && (
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-add-item"
                    onClick={() => { setAddMenuOpen(false); voice.start({ locked: true }); }}
                  >
                    <Icon icon={faMicrophone} fixedWidth /> {t('media.voice.menuItem')}
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="composer-add-item"
                  onClick={() => { setAddMenuOpen(false); setAddingTimestamp(true); }}
                >
                  <Icon icon={faClock} fixedWidth /> {t('chat.composer.timestamps')}
                </button>
              </div>
            )}
          </div>}

          <MessageEditor
            ref={inputRef}
            id="dm-input"
            className={`message-editor-wrapper${voice.active ? ' d-none' : ''}`}
            ariaLabel={texts.label}
            placeholder={texts.placeholder}
            maxLength={maxPlaintextLength}
            // Mobile: Enter is a new line; the Send button sends.
            submitOnEnter={!isMobile}
            onSubmit={handleSubmit}
            onChange={handleEditorChange}
            onKeyDown={handleInputKeyDown}
            onPasteFiles={textOnly || editing ? undefined : attachments.addFiles}
            mentionNames={mentionNames}
            mentionRoles={roleInfo}
            // Mobile: the keyboard is coming up, so the emoji panel gives way.
            onFocus={() => {
              if (!isMobile) return;
              setShowEmojiPicker(false);
              setShowAttachPanel(false);
              onInputFocus?.();
            }}
          />
          {voice.active && <VoiceRecorderBar voice={voice} dragX={voiceDragX} />}
          <div className={`chat-buttons${voice.active && voice.locked ? ' d-none' : ''}`}>
            {!voice.active && <button
              type="button"
              className="emoji-button"
              aria-label={isMobile && showEmojiPicker ? t('chat.composer.showKeyboard') : t('chat.composer.emoji')}
              aria-expanded={showEmojiPicker}
              // Don't let the picker's outside-click handler close it before this toggles.
              onMouseDown={(e) => e.stopPropagation()}
              onClick={toggleEmojiPicker}
            >
              <Icon icon={isMobile && showEmojiPicker ? faKeyboard : faFaceSmile} />
            </button>}
            {showMic ? <MicButton voice={voice} onDrag={setVoiceDragX} /> : (
              // An icon like the emoji button beside it (the word stays, for screen readers), in
              // the accent once there's something to send.
              <button
                className={`send-button${inputValue.trim() ? ' ready' : ''}`}
                type="submit"
                // The message box keeps focus, so a phone's keyboard stays up for the next message
                // (and doesn't come up if it was down).
                onMouseDown={(e) => e.preventDefault()}
              >
                <Icon icon={editing ? faCheck : faPaperPlane} />
                <span className="visually-hidden">{editing ? t('common.save') : t('chat.composer.send')}</span>
              </button>
            )}
          </div>
        </form>
      </div>

      {attachments.progress > 0 && (
        <progress value={attachments.progress} max="100" style={{ width: '100%' }} />
      )}

      {creatingPoll && <PollDialog onSubmit={sendPoll} onClose={() => setCreatingPoll(false)} />}

      {addingTimestamp && (
        <TimestampDialog
          // Mobile: not focused (as emoji), so the keyboard stays down.
          onInsert={(timestamp) => inputRef.current?.insertTimestamp(timestamp, { focus: !isMobile })}
          onClose={() => setAddingTimestamp(false)}
        />
      )}

      {attachPanelOpen && (
        <AttachPanel
          height={getKeyboardHeight()}
          picked={pickedSources}
          onAddFiles={attachments.addFiles}
          onRemove={removePicked}
          onPickFiles={attachments.pickFiles}
          onPoll={chatName ? () => { setShowAttachPanel(false); setCreatingPoll(true); } : null}
          onThread={onStartThread ? () => { setShowAttachPanel(false); onStartThread(); } : null}
          onTimestamp={() => { setShowAttachPanel(false); setAddingTimestamp(true); }}
          onError={setError}
        />
      )}

      {showEmojiPicker && isMobile && (
        // Where the keyboard would be, the same height.
        <EmojiPicker
          docked
          height={getKeyboardHeight()}
          onSelect={insertEmoji}
          onGif={sendGif}
          onClose={() => setShowEmojiPicker(false)}
        />
      )}
    </>
  );
}
