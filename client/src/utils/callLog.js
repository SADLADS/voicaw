// Calls in the chat history (server callLog.js): a row with `system` 'call' whose content is
// plaintext `{ v: 1, outcome: 'ended' | 'missed' | 'declined', duration (s), joined: [ids] }`,
// written by the server (so it's only ever shown as a notice, never as someone's message).

import { t } from '../i18n';

const OUTCOMES = new Set(['ended', 'missed', 'declined']);

// -> { outcome, duration, joined }, or null if it isn't a call row this app understands.
export function parseCallLog(msg) {
  if (msg?.system !== 'call') return null;
  try {
    const data = JSON.parse(msg.content);
    if (data?.v !== 1 || !OUTCOMES.has(data.outcome)) return null;
    const duration = Number.isFinite(data.duration) && data.duration > 0 ? data.duration : 0;
    const joined = Array.isArray(data.joined) ? data.joined.filter(Number.isInteger) : [];
    return { outcome: data.outcome, duration, joined };
  } catch {
    return null;
  }
}

// "a few seconds", "a minute", "12 minutes", "an hour and 5 minutes", "2 hours".
export function callLength(seconds) {
  if (seconds < 60) return t('chat.callLog.length.seconds');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('chat.callLog.length.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!rest) return t('chat.callLog.length.hours', { count: hours });
  return t('chat.callLog.length.hoursAndMinutes', {
    hours: t('chat.callLog.length.hours', { count: hours }),
    minutes: t('chat.callLog.length.restMinutes', { count: rest }),
  });
}

// What the row says to `meId`: { missed (this person missed it), text with the names given:
// `caller` and, in a DM, `callee` }. Someone picked up: the same for everyone. Nobody did: the
// caller hears that, everyone else that they missed it.
export function callLogText(log, { meId, callerId, caller, callee, group }) {
  if (log.outcome === 'ended') return { missed: false, text: t('chat.callLog.ended', { caller, length: callLength(log.duration) }) };
  if (meId !== callerId) return { missed: true, text: t('chat.callLog.missed', { caller }) };
  if (group) return { missed: false, text: t('chat.callLog.nobodyAnswered') };
  return { missed: false, text: log.outcome === 'declined' ? t('chat.callLog.declined', { callee }) : t('chat.callLog.noAnswer', { callee }) };
}
