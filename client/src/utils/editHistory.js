import { parsePoll } from './pollMarkup';

// Whether a message has an edit history to show (EditHistoryDialog; Edit history in
// docs/messages.md): an edited, sent message from a person. Not polls (their edits are mostly
// ending them), nor bots' and webhooks' messages, whose edits aren't kept.
export function hasEditHistory(msg) {
  return Boolean(msg.edited) && msg.status !== 'pending' && msg.status !== 'failed' && !msg.ephemeral &&
    !msg.sender_bot && !msg.webhook_id && !parsePoll(msg.plaintext);
}
