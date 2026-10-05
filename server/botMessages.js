const db = require('./db');
const webhooks = require('./routes/webhooks');
const messages = require('./routes/guildMessages');
const { cleanMessageComponents } = require('./components');

// Bots' message bodies (Discord's: content, embeds, files, allowed_mentions, flags, components),
// read and checked the same way wherever a bot writes one: the bot API's messages, interaction
// replies and follow-ups (interactions.js). Embeds and files are checked by the webhook code.

const EPHEMERAL = 1 << 6;

// A new message's parts from the request (JSON, form or multipart). Uploads the files once the
// rest is checked. Resolves to { body, content, embeds, attachments, flags, ephemeral, allowed,
// components }; throws FormError, or `{ empty: true }` for a message with nothing in it.
async function readNewMessage(req, { allowEphemeral = false } = {}) {
  const { body, files } = await webhooks.readBody(req);
  const content = webhooks.cleanContent(body.content);
  const allowed = webhooks.cleanAllowedMentions(body.allowed_mentions);
  const components = cleanMessageComponents(body.components, body.flags);
  const pending = files.map(({ file }, i) => ({ filename: webhooks.cleanFilename(file.name, i), url: `pending:${i}` }));
  webhooks.cleanEmbeds(body.embeds, pending);
  const hasEmbeds = Array.isArray(body.embeds) && body.embeds.length;
  if (!content && !files.length && !hasEmbeds && !components.length) throw Object.assign(new Error('empty'), { empty: true });
  const attachments = await webhooks.storeFiles(files, body.attachments);
  const embeds = webhooks.cleanEmbeds(body.embeds, attachments);
  const flags = webhooks.cleanFlags(body.flags);
  return {
    body, content, embeds, attachments, flags, allowed, components,
    ephemeral: allowEphemeral && Boolean(Number(body.flags) & EPHEMERAL),
  };
}

// An edit of `old` (a message with content, embeds, attachments, flags and components, as stored
// or as JSON strings): what the body changes, the rest kept. `attachments` in the body lists the
// files to keep (by id); new files are added.
async function readEdit(req, old) {
  const { body, files } = await webhooks.readBody(req);
  const list = (value) => (Array.isArray(value) ? value : messages.parseJsonList(value));
  const content = body.content !== undefined ? webhooks.cleanContent(body.content) : old.content ?? '';
  const allowed = webhooks.cleanAllowedMentions(body.allowed_mentions);
  let kept = list(old.attachments);
  if (body.attachments !== undefined) {
    const keepIds = new Set((Array.isArray(body.attachments) ? body.attachments : []).map((a) => String(a?.id)));
    kept = kept.filter((a) => keepIds.has(String(a.id)));
  }
  const components = body.components !== undefined ? cleanMessageComponents(body.components, body.flags) : list(old.components);
  const pending = files.map(({ file }, i) => ({ filename: webhooks.cleanFilename(file.name, i), url: `pending:${i}` }));
  if (body.embeds !== undefined) webhooks.cleanEmbeds(body.embeds, [...kept, ...pending]);
  const added = await webhooks.storeFiles(files, body.attachments);
  const attachments = [...kept, ...added];
  const embeds = body.embeds !== undefined ? webhooks.cleanEmbeds(body.embeds, attachments) : list(old.embeds);
  const flags = body.flags !== undefined ? webhooks.cleanFlags(body.flags) : (old.flags ?? 0) & ~(1 << 7);
  if (!content && !attachments.length && !embeds.length && !components.length) throw Object.assign(new Error('empty'), { empty: true });
  return { body, content, embeds, attachments, flags, allowed, components };
}

const jsonOrNull = (list) => (list.length ? JSON.stringify(list) : null);

// Saves `edit` (readEdit's) to guild message `messageId` in `channel` (sent by `senderId`, who
// has `permissions` there), tells the channel, and resolves to the message as the app has it.
async function saveEdit(messageId, channel, senderId, permissions, edit) {
  const { saveMentions } = require('./mentions');
  await db.transaction(async () => {
    await db.run(
      "UPDATE guild_messages SET content = ?, embeds = ?, attachments = ?, components = ?, flags = ?, edited = 1, edited_at = strftime('%s','now') WHERE id = ?",
      [edit.content, jsonOrNull(edit.embeds), jsonOrNull(edit.attachments), jsonOrNull(edit.components), edit.flags, messageId]
    );
    await saveMentions({ id: messageId, content: edit.content, sender_id: senderId }, channel, permissions, edit.allowed);
    await db.indexGuildMessage(messageId);
  });
  require('./uploads').releaseUploads();
  const [row] = await messages.withReactions([await db.get(`${messages.MESSAGE_SELECT} WHERE m.id = ?`, [messageId])]);
  const { sendToChannel } = require('./guilds');
  await sendToChannel(channel, {
    type: 'guild_message_edit',
    guildId: channel.guild_id,
    channelId: channel.id,
    messageId: row.id,
    content: row.content,
    embeds: row.embeds,
    attachments: row.attachments,
    components: row.components,
    flags: row.flags,
    mention_everyone: row.mention_everyone,
    mention_roles: row.mention_roles,
  });
  require('./linkPreviews').refreshLinkPreviews(row.id);
  return row;
}

module.exports = { EPHEMERAL, readNewMessage, readEdit, saveEdit };
