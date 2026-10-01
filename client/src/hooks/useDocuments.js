import { useCallback, useEffect, useRef, useState } from 'react';
import { onGuildEvent, setActiveChat } from '../utils/ws-client';
import {
  addDocumentReaction,
  fetchDocument,
  fetchDocuments,
  markChannelRead,
  removeDocumentReaction,
} from '../services/guildService';

// Document channels: the feed (useDocumentFeed) and one open document (useDocument), kept
// current by the websocket. Replies are guild messages (useChannel with a documentId).

const newestReply = (documents) => documents.reduce((max, d) => Math.max(max, d.last_reply_id ?? 0), 0);

// Adds or removes your `emoji` on `target` (a document); the change arrives through `apply`
// (also used for websocket events, so it's never counted twice).
export async function toggleDocumentReaction(target, userId, emoji, apply) {
  const mine = target.reactions.find((r) => r.user_id === userId && r.emoji === emoji);
  if (mine) {
    await removeDocumentReaction(mine.id);
    apply({ type: 'guild_document_reaction_remove', documentId: target.id, reactionId: mine.id });
  } else {
    const reaction = await addDocumentReaction(target.id, emoji);
    apply({ type: 'guild_document_reaction_add', reaction });
  }
}

// A document (card or whole) with a reaction event applied, or unchanged.
function withReactionEvent(document, event) {
  if (event.type === 'guild_document_reaction_add' && event.reaction.document_id === document.id) {
    if (document.reactions.some((r) => r.id === event.reaction.id)) return document;
    const { document_id: _, ...reaction } = event.reaction;
    return { ...document, reactions: [...document.reactions, reaction] };
  }
  if (event.type === 'guild_document_reaction_remove' && event.documentId === document.id) {
    return { ...document, reactions: document.reactions.filter((r) => r.id !== event.reactionId) };
  }
  return document;
}

// The channel's documents (cards, newest first). While the feed is shown, the channel stays
// marked read (`onRead` refreshes unread badges after).
export function useDocumentFeed({ channelId, showing, onRead }) {
  const [documents, setDocuments] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  const reload = useCallback(async () => {
    try {
      const list = await fetchDocuments(channelId);
      setDocuments(list);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoaded(true);
    }
  }, [channelId]);

  useEffect(() => {
    setDocuments([]);
    setLoaded(false);
    reload();
  }, [reload]);

  const apply = useCallback((event) => {
    switch (event.type) {
      case 'guild_document_upsert':
        setDocuments((prev) => {
          const at = prev.findIndex((d) => d.id === event.document.id);
          if (at === -1) return [event.document, ...prev].sort((a, b) => b.id - a.id);
          const next = [...prev];
          next[at] = event.document;
          return next;
        });
        break;
      case 'guild_document_delete':
        setDocuments((prev) => prev.filter((d) => d.id !== event.documentId));
        break;
      case 'guild_document_reaction_add':
      case 'guild_document_reaction_remove':
        setDocuments((prev) => prev.map((d) => withReactionEvent(d, event)));
        break;
      case 'guild_message_new': {
        const { document_id: documentId, id, timestamp, system } = event.message;
        if (!documentId || system) break;
        setDocuments((prev) => prev.map((d) => (d.id === documentId && (d.last_reply_id ?? 0) < id
          ? { ...d, reply_count: d.reply_count + 1, last_reply_id: id, last_reply_at: timestamp }
          : d)));
        break;
      }
      case 'guild_message_delete':
        // A reply's document isn't in the event: the counts are fetched again.
        if (documentsRef.current.some((d) => d.last_reply_id != null)) reload();
        break;
      default:
    }
  }, [reload]);

  useEffect(() => {
    if (!channelId) return undefined;
    const id = Number(channelId);
    return onGuildEvent((event) => {
      if (event.channelId === id || event.message?.channel_id === id) apply(event);
    });
  }, [channelId, apply]);

  // Shown: the channel counts as being looked at (no pushes for it), and is read.
  const newest = newestReply(documents);
  useEffect(() => {
    if (!showing || !channelId) return undefined;
    setActiveChat(`channel-${channelId}`);
    return () => setActiveChat(null);
  }, [showing, channelId]);
  useEffect(() => {
    if (!showing || !loaded || !channelId) return;
    markChannelRead(channelId, newest)
      .then(() => onReadRef.current?.())
      .catch((err) => console.warn('Failed to mark channel as read', err));
  }, [showing, loaded, channelId, newest]);

  return { documents, loaded, error, reload, apply };
}

// One document, content and all (null while loading; `missing` once it's gone or can't be
// seen). `replace` puts in a newer copy (after a save).
export function useDocument(documentId) {
  const [document, setDocument] = useState(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setDocument(null);
    setMissing(false);
    if (!documentId) return undefined;
    let cancelled = false;
    fetchDocument(documentId)
      .then((doc) => { if (!cancelled) setDocument(doc); })
      .catch(() => { if (!cancelled) setMissing(true); });
    return () => { cancelled = true; };
  }, [documentId]);

  const apply = useCallback((event) => {
    if (event.type === 'guild_document_update' && event.document.id === documentId) {
      setDocument((prev) => (!prev || prev.version <= event.document.version ? event.document : prev));
    } else if (event.type === 'guild_document_delete' && event.documentId === documentId) {
      setMissing(true);
    } else if (event.type === 'guild_document_reaction_add' || event.type === 'guild_document_reaction_remove') {
      setDocument((prev) => (prev ? withReactionEvent(prev, event) : prev));
    }
  }, [documentId]);

  useEffect(() => {
    if (!documentId) return undefined;
    return onGuildEvent(apply);
  }, [documentId, apply]);

  const replace = useCallback((doc) => setDocument(doc), []);
  return { document, missing, apply, replace };
}
