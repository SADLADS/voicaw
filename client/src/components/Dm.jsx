import React, { useEffect, useRef, useState, useContext } from 'react';
import { useParams } from 'react-router-dom';
import '../assets/css/dms.css';
import { onNewDm, onDeleteDm, onEditDm } from '../utils/ws-client';
import { LayoutContext } from './Layout';
import { fetchMessagesForUser, sendMessageToUser, markMessagesRead } from '../services/dmService';
import { encryptMessage, decryptMessage, deriveSharedKey, decryptMessagesBatch } from '../services/encryptionService';
import { loadPrivateKey } from '../services/keyStore';
import { uploadAttachment, MAX_ATTACHMENT_BYTES } from '../services/attachmentUpload';
import { buildAttachmentUrl, ENCRYPTION_OVERHEAD_BYTES } from '../services/attachmentCrypto';
import {
  makePlaceholder,
  findPlaceholderIds,
  removePlaceholder,
  replacePlaceholders,
} from '../utils/attachmentMarkup';
import { seedAttachmentCache } from '../services/attachmentCache';
import { formatBytes } from '../utils/formatBytes';
import { readMediaDimensions } from '../utils/mediaDimensions';
import AttachmentTray from './AttachmentTray';
import { ConfigContext } from '../App';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { InteractionContext } from "../App";
import api from '../utils/api';
import MessageList from './MessageList';


export default function Dm({ user }) {
  const { s3Endpoint, maxPlaintextLength } = useContext(ConfigContext);
  const { isMobile } = useContext(InteractionContext);


  // Older history is fetched in pages this size as you scroll up.
  const PAGE_SIZE = 50;


  const { unreadDms, users, errorUsers, fetchUnreadMessages } = useContext(LayoutContext);
  const { id } = useParams();

  const [messages, setMessages] = useState([]);
  const [errorMessages, setErrorMessages] = useState(null);
  const [inputValue, setInputValue] = useState('');
  const [hasMore, setHasMore] = useState(true);

  const inputRef = useRef(null);
  const editRef = useRef(null);
  // Always the current render's messages, for the load-older handler to dedupe against.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const loadingOlder = useRef(false);
  // The conversation currently being shown, so late responses for a previous one are ignored.
  const activeChatId = useRef(id);

  const [sharedKey, setSharedKey] = useState(null);

  const chatUser = users.find((u) => u.id.toString() === id);

  const [isLoading, setIsLoading] = useState(true);

  const [hoveredMsgId, setHoveredMsgId] = useState(null);

  const [messageToReply, setMessageToReply] = useState(null);

  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingMessageContent, setEditingMessageContent] = useState('');
  const [progress, setProgress] = useState(0);

  // Files attached to the message being composed. They stay local (referenced from the
  // text as `![name](attachment:ID)`) until the message is sent.
  const [drafts, setDrafts] = useState([]);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const nextDraftId = useRef(1);
  const [composerError, setComposerError] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepth = useRef(0);

  // FUNCTIONS

  // ATTACHMENTS

  function addDraftAttachments(files) {
    if (files.length === 0) return;

    const tooBig = files.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
    const accepted = files.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
    setComposerError(
      tooBig.length > 0
        ? `${tooBig.map((f) => f.name).join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} over the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit.`
        : null
    );
    if (accepted.length === 0) return;

    const newDrafts = accepted.map((file) => ({
      id: nextDraftId.current++,
      file,
      name: file.name || 'file',
      type: file.type || 'application/octet-stream',
      size: file.size,
      previewUrl: URL.createObjectURL(file),
    }));
    setDrafts((prev) => [...prev, ...newDrafts]);

    // Record image/video sizes (sent in the attachment URL) so receivers can reserve the
    // right space before the file loads.
    newDrafts.forEach((d) => {
      readMediaDimensions(d.file, d.previewUrl).then((dims) => {
        if (dims) setDrafts((prev) => prev.map((x) => (x.id === d.id ? { ...x, ...dims } : x)));
      });
    });

    // Insert the placeholders at the cursor (or over the selection).
    const markup = newDrafts.map((d) => makePlaceholder(d.id, d.name)).join('\n');
    const textarea = inputRef.current;
    const start = textarea?.selectionStart ?? inputValue.length;
    const end = textarea?.selectionEnd ?? start;
    setInputValue((prev) => prev.slice(0, start) + markup + prev.slice(end));

    const cursor = start + markup.length;
    setTimeout(() => {
      textarea?.focus();
      textarea?.setSelectionRange(cursor, cursor);
    }, 0);
  }


  function removeDraft(id) {
    const draft = drafts.find((d) => d.id === id);
    if (draft) URL.revokeObjectURL(draft.previewUrl);
    setDrafts((prev) => prev.filter((d) => d.id !== id));
    setInputValue((prev) => removePlaceholder(prev, id));
  }


  function handleAttachFile() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.style.display = 'none';

    fileInput.onchange = (e) => {
      addDraftAttachments(Array.from(e.target.files || []));
      fileInput.remove();
    };

    document.body.appendChild(fileInput);
    fileInput.click();
  }


  function handlePaste(e) {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length === 0) return; // plain text paste
    e.preventDefault();
    addDraftAttachments(files);
  }


  // Only react to drags carrying files, so dragging text into the textarea still works.
  const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  function handleDragEnter(e) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current++;
    setIsDragOver(true);
  }

  function handleDragLeave(e) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragOver(false);
  }

  function handleDragOver(e) {
    if (isFileDrag(e)) e.preventDefault();
  }

  function handleDrop(e) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragOver(false);
    addDraftAttachments(Array.from(e.dataTransfer.files || []));
  }


  // The final attachment URL has a fixed shape (see attachmentCrypto/attachmentUpload), so
  // a same-length stand-in lets us check the message length before uploading anything.
  function projectedAttachmentUrl(draft) {
    return buildAttachmentUrl(`${s3Endpoint}/uploads/${'0'.repeat(36)}.bin`, {
      key: 'A'.repeat(43),
      type: draft.type,
      size: draft.size,
      width: draft.width,
      height: draft.height,
    });
  }


  async function uploadDrafts(attachments) {
    const total = attachments.reduce((sum, d) => sum + d.size + ENCRYPTION_OVERHEAD_BYTES, 0);
    const loaded = {};
    const report = () => {
      const done = Object.values(loaded).reduce((a, b) => a + b, 0);
      setProgress(Math.max(1, Math.round((done / total) * 100)));
    };

    report();
    try {
      const entries = await Promise.all(
        attachments.map(async (d) => {
          const dims = d.width && d.height ? { width: d.width, height: d.height } : null;
          const url = await uploadAttachment(d.file, (bytes) => {
            loaded[d.id] = bytes;
            report();
          }, dims);
          return [d.id, url];
        })
      );
      return Object.fromEntries(entries);
    } finally {
      setProgress(0);
    }
  }




  function handleEdit(msg) {
    setEditingMessageId(msg.id);
    setEditingMessageContent(msg.plaintext);
    setTimeout(() => {
      const textarea = document.getElementById(`edit-input-${msg.id}`);
      if (textarea) {
        textarea.focus();
        const length = textarea.value.length;
        textarea.setSelectionRange(length, length); // cursor at end
      }
    }, 0);
  }


  async function handleSaveEdit(id) {
    try {
      const plaintextEditingContent = await encryptMessage(editingMessageContent, sharedKey);
      await api.put(`/update-message/${id}`, { content: plaintextEditingContent });

      // Update the message locally
      setMessages(prev =>
        prev.map(msg =>
          msg.id === id ? { ...msg, plaintext: editingMessageContent } : msg
        )
      );

      // Exit edit mode
      setEditingMessageId(null);
    } catch (err) {
      console.error('Failed to edit message', err);
    }
  }



  async function handleDelete(msg) {
    try {
      await api.delete(`/messages/${msg.id}`);
      // Remove message from local state
      setMessages(prev => prev.filter(m => m.id !== msg.id));
    } catch (err) {
      console.error('Failed to delete message', err);
    }
  }


  function handleReply(msg) {
    setMessageToReply(msg);
    inputRef.current?.focus();
  }


  function handleIncomingMessage(message, alreadyPlain = false) {
    const decryptedNewMessage = alreadyPlain ? message : { ...message };

    setMessages(prev => {
      // check if message exists by id
      const byId = prev.findIndex(m => m.id === decryptedNewMessage.id);
      if (byId !== -1) return prev; // duplicate, skip

      // check if temp message exists (by matching sender, recipient, content)
      const tempIndex = prev.findIndex(
        m =>
          m.status === 'pending' &&
          m.sender_id === decryptedNewMessage.sender_id &&
          m.recipient_id === decryptedNewMessage.recipient_id &&
          m.plaintext === decryptedNewMessage.plaintext
      );

      if (tempIndex !== -1) {
        // replace temp message with real message, keeping its list key stable
        const updated = [...prev];
        updated[tempIndex] = {
          ...decryptedNewMessage,
          clientKey: prev[tempIndex].clientKey ?? prev[tempIndex].id,
        };
        return updated;
      }

      // add new message normally
      const fromId = decryptedNewMessage.sender_id.toString();
      const currentChatUserId = chatUser.id.toString();
      const currentUserId = user.id.toString();

      const isIncomingFromCurrentChatUser = fromId === currentChatUserId;
      const isOutgoingFromSelf =
        fromId === currentUserId && decryptedNewMessage.recipient_id?.toString() === currentChatUserId;

      if (isIncomingFromCurrentChatUser || isOutgoingFromSelf) {
        if (isIncomingFromCurrentChatUser) markRead();
        return [...prev, decryptedNewMessage];
      } else {
        const dot = document.getElementById(`user-dot-${fromId}`);
        if (dot) dot.classList.add('active');
        return prev;
      }
    });
  }




  const loadMoreMessages = async () => {
    // The list can ask again (every scroll event near the top) before this page arrives.
    if (loadingOlder.current || !sharedKey) return;
    const oldest = messagesRef.current[0];
    if (!oldest) return;

    loadingOlder.current = true;
    const chatId = id;
    try {
      const page = await fetchMessagesForUser(chatId, { before: oldest.id, limit: PAGE_SIZE });
      const decrypted = await decryptMessagesBatch(page, sharedKey);
      if (activeChatId.current !== chatId) return;

      // Skip anything already shown (e.g. overlapping pages), which would otherwise
      // render twice under the same key.
      const known = new Set(messagesRef.current.map((m) => m.id));
      const fresh = decrypted.filter((m) => !known.has(m.id));
      if (fresh.length > 0) setMessages((prev) => [...fresh, ...prev]);
      setHasMore(page.length > 0);
    } catch (e) {
      // Keep the conversation on screen; scrolling back to the top retries.
      console.error('Failed to load older messages:', e);
    } finally {
      if (activeChatId.current === chatId) loadingOlder.current = false;
    }
  };


  const markRead = async () => {
    try {
      if (!chatUser) return;
      await markMessagesRead(chatUser.id);
      fetchUnreadMessages?.();
    } catch (err) {
      console.warn('Failed to mark messages as read', err);
    }
  };


  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!inputValue.trim() || !chatUser) return;

    const messageText = inputValue.trim();
    const referencedIds = findPlaceholderIds(messageText);
    const attachments = drafts.filter((d) => referencedIds.has(d.id));

    // Placeholders are much shorter than the final attachment URLs, so check the length
    // the message will have once they're swapped in.
    const projectedText = replacePlaceholders(
      messageText,
      Object.fromEntries(attachments.map((d) => [d.id, projectedAttachmentUrl(d)]))
    );
    if (projectedText.length > maxPlaintextLength) {
      setComposerError(
        `Message is ${projectedText.length - maxPlaintextLength} characters too long once attachment links are added.`
      );
      return;
    }
    setComposerError(null);

    setInputValue('');
    // Drafts whose placeholder was deleted from the text are dropped; the rest now belong
    // to the pending message.
    drafts.filter((d) => !referencedIds.has(d.id)).forEach((d) => URL.revokeObjectURL(d.previewUrl));
    setDrafts([]);

    const tempId = `temp-${Date.now()}`;

    const pm_id = messageToReply?.id || null;
    const pm_plaintext = messageToReply?.plaintext || null;

    const tempMessage = {
      id: tempId,
      sender_id: user.id,
      recipient_id: chatUser.id,
      plaintext: messageText,
      status: 'pending',
      timestamp: Math.floor(Date.now() / 1000),
      sender_username: user.username,
      parent_message_id: pm_id,
      parent_plaintext: pm_plaintext,
      // Lets the pending message show attachments from the local files while they upload.
      localAttachments: Object.fromEntries(
        attachments.map((d) => [
          d.id,
          { previewUrl: d.previewUrl, type: d.type, size: d.size, width: d.width, height: d.height },
        ])
      ),
    };

    setMessageToReply(null)

    // Add temp message
    setMessages(prev => [...prev, tempMessage]);

    try {
      let finalText = messageText;

      if (attachments.length > 0) {
        const urls = await uploadDrafts(attachments);
        finalText = replacePlaceholders(messageText, urls);
        attachments.forEach((d) => seedAttachmentCache(urls[d.id], d.previewUrl));

        // Swap the real text in before sending: our own websocket echo of this message
        // is matched to the pending one by plaintext.
        setMessages(prev =>
          prev.map(msg => (msg.id === tempId ? { ...msg, plaintext: finalText } : msg))
        );
      }

      const encryptedMessage = await encryptMessage(finalText, sharedKey);
      const savedMessage = await sendMessageToUser(chatUser.id, encryptedMessage, pm_id);

      // Replace temp message
      setMessages(prev =>
        prev.map(msg =>
          msg.id === tempId
            ? {
              ...savedMessage,
              clientKey: tempId,
              plaintext: finalText,
              status: 'sent',
              timestamp: savedMessage.timestamp || tempMessage.timestamp,
              parent_plaintext: pm_plaintext,
            }
            : msg
        )
      );

      setErrorMessages(null);
    } catch (error) {
      console.error('Error sending message:', error);

      // Mark temp message as failed
      setMessages(prev =>
        prev.map(msg =>
          msg.id === tempId ? { ...msg, status: 'failed' } : msg
        )
      );

      setComposerError(`Message failed to send: ${error.message}`);
    }
  };


  // USEEFFECTS


  // Unsent attachments belong to the conversation they were added in.
  useEffect(() => {
    return () => {
      const dropped = draftsRef.current;
      dropped.forEach((d) => URL.revokeObjectURL(d.previewUrl));
      setDrafts([]);
      setInputValue((prev) => dropped.reduce((text, d) => removePlaceholder(text, d.id), prev));
      setComposerError(null);
    };
  }, [id]);


  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === "Escape") {
        setMessageToReply(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);


  // Load a conversation: derive the shared key, then fetch the newest page. This is the
  // only place history is (re)loaded; older pages are only ever prepended by
  // loadMoreMessages.
  useEffect(() => {
    activeChatId.current = id;
    loadingOlder.current = false;
    setMessages([]);
    setHasMore(true);
    setErrorMessages(null);
    setSharedKey(null);

    const publicKey = chatUser?.public_key;
    if (!id || !publicKey) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        const privateKey = await loadPrivateKey();
        if (!privateKey) throw new Error("No private key found.");
        const key = await deriveSharedKey(privateKey, publicKey);

        const page = await fetchMessagesForUser(id, { limit: PAGE_SIZE });
        const decrypted = await decryptMessagesBatch(page, key);
        if (cancelled) return;

        setSharedKey(key);
        setMessages(decrypted);
        setHasMore(page.length > 0);
      } catch (e) {
        if (cancelled) return;
        console.error("Failed to load chat data:", e);
        setErrorMessages(e.message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, chatUser?.public_key]);


  useEffect(() => {
    if (!chatUser?.id) return;
    markRead();
    const dot = document.getElementById(`user-dot-${chatUser?.id}`);
    if (dot) {
      dot.classList.remove('active');
    }
  }, [chatUser?.id]);


  useEffect(() => {
    if (!user?.id || !chatUser?.id || !sharedKey) return;

    const unsubscribe = onNewDm(async (message) => {
      console.log("new dm!", message);
      // If there's already plaintext on the message, use it.
      if (message.plaintext) {
        handleIncomingMessage(message, true);
        return;
      }

      if (!sharedKey) {
        console.warn("Received DM but sharedKey not ready. Skipping decrypt for message:", message.id);
        return;
      }

      try {
        const plaintext = await decryptMessage(message.content, sharedKey);
        let parent_plaintext = "";
        if (message.parent_message_id && message.parent_content) {
          try {
            parent_plaintext = await decryptMessage(message.parent_content, sharedKey);
          } catch (e) {
            console.warn("Failed to decrypt parent message", message.parent_message_id, e);
          }
        }
        const decryptedNewMessage = { ...message, plaintext, parent_plaintext };

        handleIncomingMessage(decryptedNewMessage);
      } catch (err) {
        console.warn("Failed to decrypt incoming DM", message.id, err);
        // Do null plaintext so UI won't crash
        const fallback = { ...message, plaintext: null };
        handleIncomingMessage(fallback);
      }
    });

    return () => unsubscribe();
  }, [chatUser?.id, user?.id, sharedKey]);


  useEffect(() => {
    const unsubscribeDelete = onDeleteDm(({ messageId, sender_id }) => {
      const currentChatUserId = chatUser?.id?.toString();
      if (!currentChatUserId) return;

      setMessages(prev =>
        prev.filter(msg =>
          msg.id !== messageId &&
          (msg.sender_id?.toString() === currentChatUserId || msg.recipient_id?.toString() === currentChatUserId)
        )
      );
    });

    return () => unsubscribeDelete();
  }, [chatUser?.id]);


  useEffect(() => {
    const unsubscribeEdit = onEditDm(({ messageId, content, sender_id }) => {
      const updateMessage = async () => {
        try {
          const plaintextEdit = await decryptMessage(content, sharedKey);
          const currentChatUserId = chatUser?.id?.toString();
          if (!currentChatUserId) return;

          setMessages(prev =>
            prev.map(msg =>
              msg.id === messageId &&
                (msg.sender_id?.toString() === currentChatUserId || msg.recipient_id?.toString() === currentChatUserId)
                ? { ...msg, plaintext: plaintextEdit, edited: 1 }
                : msg
            )
          );
        } catch (err) {
          console.error("Failed to decrypt edited message", err);
        }
      };

      updateMessage();
    });

    return () => unsubscribeEdit();
  }, [chatUser?.id, sharedKey]);


  useEffect(() => {
    const textarea = inputRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [inputValue]);



  // The tray only shows drafts still referenced from the text; unreferenced ones are kept
  // until send so that undoing a deletion brings them back.
  const referencedDraftIds = findPlaceholderIds(inputValue);
  const visibleDrafts = drafts.filter((d) => referencedDraftIds.has(d.id));

  return (
    <div
      id="dm-main"
      data-current-user-id={user?.id}
      data-other-user-id={chatUser?.id}
    >
      {errorUsers && <p className="error-text">Error loading users: {errorUsers}</p>}
      {users.length === 0 && !errorUsers && !id && <p>No recent conversations found.</p>}

      {id && (
        <>
          <h4 className="chat-recipient-header">{chatUser?.username || 'User'}</h4>

          <div className="dm-message-wrapper">
            {isLoading ? (
              <p></p>
            ) : errorMessages ? (
              <p className="error-text">Error: {errorMessages}</p>
            ) : messages.length === 0 ? (
              <p>No messages yet. Start the conversation!</p>
            ) : (
              <MessageList
                messages={messages}
                user={user}
                hasMore={hasMore}
                loadMoreMessages={loadMoreMessages}
                s3Endpoint={s3Endpoint}
                hoveredMsgId={hoveredMsgId}
                setHoveredMsgId={setHoveredMsgId}
                handleEdit={handleEdit}
                handleDelete={handleDelete}
                handleReply={handleReply}
                editingMessageId={editingMessageId}
                editingMessageContent={editingMessageContent}
                setEditingMessageContent={setEditingMessageContent}
                setEditingMessageId={setEditingMessageId}
                handleSaveEdit={handleSaveEdit}
                isMobile={isMobile}
                editRef={editRef}
                maxPlaintextLength={maxPlaintextLength}
              />

            )}
          </div>

          <div
            className={`dm-chat-wrapper${isDragOver ? ' drag-over' : ''}`}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {messageToReply && (
              <div className="reply-bar">
                <span>
                  Replying to <strong>{messageToReply?.sender_username}</strong>
                </span>
                <button
                  className="reply-close"
                  onClick={() => setMessageToReply(null)}
                  type="button"
                >
                  ×
                </button>
              </div>
            )}

            {composerError && (
              <div className="composer-error" role="alert">
                <span>{composerError}</span>
                <button className="reply-close" onClick={() => setComposerError(null)} type="button">
                  ×
                </button>
              </div>
            )}

            <AttachmentTray drafts={visibleDrafts} onRemove={removeDraft} />

            <form
              id="dm-chat-form"
              className="d-flex flex-grow-1"
              onSubmit={handleSendMessage}
            >
              <div className="attach-wrapper">
                <button
                  className="attach-button"
                  type="button"
                  onClick={handleAttachFile}
                >
                  <FontAwesomeIcon icon={faPlus} />
                </button>
              </div>

              <textarea
                id="dm-input"
                className="form-control auto-resize-textarea"
                placeholder={`Message ${chatUser?.username || 'User'}...`}
                value={inputValue}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value.length <= maxPlaintextLength) {
                    setInputValue(value);
                  } else {
                    setInputValue(value.slice(0, maxPlaintextLength));
                  }
                }}
                onKeyDown={(e) => {
                  if (!isMobile && e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage(e);
                  }
                }}
                onPaste={handlePaste}
                autoComplete="off"
                ref={inputRef}
                rows={1}
              />
              <div className="chat-buttons">
                <button className="emoji-button">
                  😎
                </button>
                <button className="send-button" type="submit">
                  Send
                </button>
              </div>
            </form>
          </div>
          {progress > 0 && (
            <progress value={progress} max="100" style={{ width: "100%" }} />
          )}

          {/* <div className="char-count">
            {inputValue.length}/{maxPlaintextLength}
          </div> */}
        </>
      )}
    </div>
  );
}