import React, { useEffect, useRef, useState, useContext } from 'react';
import { useParams } from 'react-router-dom';
import '../assets/css/dms.css';
import { onNewDm, onDeleteDm, onEditDm } from '../utils/ws-client';
import { LayoutContext } from './Layout';
import { fetchMessagesForUser, sendMessageToUser, markMessagesRead } from '../services/dmService';
import { encryptMessage, decryptMessage, deriveSharedKey, decryptMessagesBatch } from '../services/encryptionService';
import { ConfigContext } from '../App';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { InteractionContext } from "../App";
import api from '../utils/api';
import MessageList from './MessageList';


export default function Dm({ user }) {
  const { s3Endpoint, maxPlaintextLength } = useContext(ConfigContext);
  const { isMobile } = useContext(InteractionContext);


  const INITIAL_INDEX = 100000;

  const [firstItemIndex, setFirstItemIndex] = useState(INITIAL_INDEX);

  const { unreadDms, users, errorUsers, fetchUnreadMessages } = useContext(LayoutContext);
  const { id } = useParams();

  const [messages, setMessages] = useState([]);
  const [errorMessages, setErrorMessages] = useState(null);
  const [inputValue, setInputValue] = useState('');
  const [hasMore, setHasMore] = useState(true);

  const inputRef = useRef(null);
  const editRef = useRef(null);
  const initialLoad = useRef(true);

  const [sharedKey, setSharedKey] = useState(null);

  const chatUser = users.find((u) => u.id.toString() === id);

  const [isLoading, setIsLoading] = useState(true);

  const [hoveredMsgId, setHoveredMsgId] = useState(null);

  const [messageToReply, setMessageToReply] = useState(null);

  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingMessageContent, setEditingMessageContent] = useState('');

  // FUNCTIONS

  async function uploadAndInsertFile(file) {
    const textarea = inputRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const before = inputValue.slice(0, cursorPos);
    const after = inputValue.slice(cursorPos);

    try {
      const { data } = await api.get("/upload_file", { params: { type: file.type } });
      const { fileUrl, uploadUrl } = data;
      if (!uploadUrl) throw new Error("Invalid upload URL");

      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploadRes.ok) throw new Error("Upload failed");

      const markdown = `![](${fileUrl})`;
      setInputValue(before + markdown + after);

      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(cursorPos + markdown.length, cursorPos + markdown.length);
      }, 0);

    } catch (err) {
      console.error("File upload failed:", err);
      alert("File upload failed");
    }
  }


  async function handleAttachFile() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';

    fileInput.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (file) await uploadAndInsertFile(file);
      fileInput.remove();
    };

    document.body.appendChild(fileInput);
    fileInput.click();
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
        // replace temp message with real message
        const updated = [...prev];
        updated[tempIndex] = decryptedNewMessage;
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


  async function fetchMessages(beforeId = null) {
    console.log("fetch messages!")
    try {
      const data = await fetchMessagesForUser(id, { before: beforeId });
      const privatePEM = localStorage.getItem('privateKey');
      if (!privatePEM) throw new Error("No private key found for decryption.");
      const decryptedNewMessages = await decryptMessagesBatch(data, sharedKey)
      if (beforeId) {
        setMessages((prev) => [...decryptedNewMessages, ...prev]);
      } else {
        setMessages(decryptedNewMessages);
      }
      setHasMore(data.length > 0);
      setErrorMessages(null);
    } catch (e) {
      setErrorMessages(e.message);
    }
  }


  const loadMoreMessages = async () => {
    console.log("load more!")
    const oldest = messages[0];
    if (!oldest) return;

    try {
      const newMessages = await fetchMessagesForUser(id, { before: oldest.id });

      const privatePEM = localStorage.getItem('privateKey');
      if (!privatePEM) throw new Error("No private key found for decryption.");
      if (!chatUser) throw new Error("Chat user not loaded for decryption.");

      const decryptedNewMessages = await decryptMessagesBatch(newMessages, sharedKey)

      if (decryptedNewMessages.length > 0) {
        setMessages((prev) => [...decryptedNewMessages, ...prev]);
        setFirstItemIndex((prev) => prev - decryptedNewMessages.length);
      }

      setHasMore(decryptedNewMessages.length > 0);
    } catch (e) {
      setErrorMessages(e.message);
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
    setInputValue('');
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
    };

    setMessageToReply(null)

    // Add temp message
    setMessages(prev => [...prev, tempMessage]);

    try {
      const encryptedMessage = await encryptMessage(messageText, sharedKey);
      const savedMessage = await sendMessageToUser(chatUser.id, encryptedMessage, pm_id);

      // Replace temp message
      setMessages(prev =>
        prev.map(msg =>
          msg.id === tempId
            ? {
              ...savedMessage,
              plaintext: messageText,
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

      setErrorMessages(error.message);
    }
  };


  // USEEFFECTS


  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;

    const handlePaste = async (e) => {
      if (!e.clipboardData) return;

      const items = e.clipboardData.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) await uploadAndInsertFile(file);
        }
      }
    };

    textarea.addEventListener('paste', handlePaste);
    return () => textarea.removeEventListener('paste', handlePaste);
  }, [inputValue]);


  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === "Escape") {
        setMessageToReply(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);


  useEffect(() => {
    if (!id || !chatUser?.public_key) {
      setMessages([]);
      setIsLoading(false);
      return;
    }

    const loadChatData = async () => {
      setIsLoading(true);
      setMessages([]);
      setFirstItemIndex(INITIAL_INDEX);
      setHasMore(true);
      setErrorMessages(null);

      try {
        // derive the shared key
        const privatePEM = localStorage.getItem('privateKey');
        if (!privatePEM) throw new Error("No private key found.");

        const key = await deriveSharedKey(privatePEM, chatUser.public_key);
        setSharedKey(key);

        // Fetch initial messages with the new key
        const initialMessages = await fetchMessagesForUser(id);

        // decrypt the messages
        const decryptedMessages = await decryptMessagesBatch(initialMessages, key);

        // set the state
        setMessages(decryptedMessages);
        setHasMore(initialMessages.length > 0);

      } catch (e) {
        console.error("Failed to load chat data:", e);
        setErrorMessages(e.message);
        setMessages([]); // clear messages on error
      } finally {
        setIsLoading(false); // stop loading
      }
    };

    loadChatData();

  }, [id, chatUser]);


  useEffect(() => {
    setFirstItemIndex(INITIAL_INDEX);
    setMessages([]);
    setHasMore(true);
    if (!id) return;
  }, [id, chatUser]);


  useEffect(() => {
    async function deriveKey() {
      if (!chatUser?.public_key) {
        setSharedKey(null);
        return;
      }

      try {
        const privatePEM = localStorage.getItem('privateKey');
        if (!privatePEM) throw new Error("No private key found for decryption.");
        const key = await deriveSharedKey(privatePEM, chatUser.public_key);
        setSharedKey(key);
        console.log("set shared key!", key);
      } catch (e) {
        console.error("Failed to derive shared key:", e);
        setSharedKey(null);
      }
    }

    // reset UI state when switching chats
    setMessages([]);
    setHasMore(true);
    setFirstItemIndex(INITIAL_INDEX);

    deriveKey();
  }, [chatUser?.public_key]);


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


  useEffect(() => {
    if (sharedKey) {
      fetchMessages();
    }
  }, [sharedKey]);



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
                firstItemIndex={firstItemIndex}
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

          <div className="dm-chat-wrapper">
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
          {/* <div className="char-count">
            {inputValue.length}/{maxPlaintextLength}
          </div> */}
        </>
      )}
    </div>
  );
}