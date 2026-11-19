import { resolvePath } from './archive';

// DiscordChatExporter's JSON (one file per channel, the usual archiver output) made into the
// history import's own shape (docs/guilds.md, History imports), so other archive formats can
// be added as other adapters. Its content is already plain text: mentions are "@Nickname"
// (with the people in `mentions`), custom emoji ":name:" (in `inlineEmojis`), channels
// "#name". Mentions of people and custom emoji become `<@archiveId>` and `<:name:archiveId>`,
// which the server makes members' mentions (no ping) and the guild's emoji, or plain text again.
// Without its media folder (`--media`), files are links to the old CDN: the importer's browser
// can download them (`remoteUrl`, only from that CDN; attachments' links stop working about a
// day after the export, so expired ones aren't tried), else they're "not included". Links' previews aren't kept (the server makes its own), only bots' rich embeds'
// text. Polls aren't in these exports; the "poll ended" message names the question and the
// winner, which become text (`pollText`, in the importer's language).

export const SOURCE = 'discord-chat-exporter';

// Whether a parsed JSON file is one of its exports.
export const isExport = (json) => Boolean(json && typeof json === 'object' && json.channel?.id && Array.isArray(json.messages));

const THREAD_TYPES = new Set(['GuildPublicThread', 'GuildPrivateThread', 'GuildNewsThread', '10', '11', '12']);
// The kinds of message brought over: ordinary ones, replies, bots' answers to commands, "poll
// ended". Joins, pins, boosts, calls... are left out.
const KINDS = new Set(['Default', 'Reply', '0', '19', '20', '23', 'ChatInputCommand', 'ContextMenuCommand']);
const POLL_RESULT = new Set(['46', 'PollResult']);
const COMMAND_KINDS = new Set(['20', '23', 'ChatInputCommand', 'ContextMenuCommand']);

const isWeb = (url) => typeof url === 'string' && /^[a-z]+:\/\//i.test(url);

// Where the archive's files, pictures and emoji are, when they're links: the only addresses
// the importer's browser is asked to download from (an archive is someone else's file).
const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

// A link the browser can download now -> the URL, else null. `expired` is set to true for an
// attachment's link past its signed expiry (`ex`, hex seconds) or with none (links from before
// they were signed no longer work). Pictures of people, emoji and stickers don't expire.
export function downloadable(url, { now = Date.now() } = {}) {
  if (!isWeb(url)) return { url: null, expired: false };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { url: null, expired: false };
  }
  if (parsed.protocol !== 'https:' || !CDN_HOSTS.has(parsed.hostname)) return { url: null, expired: false };
  if (/^\/(ephemeral-)?attachments\//.test(parsed.pathname)) {
    const ex = parseInt(parsed.searchParams.get('ex') ?? '', 16);
    if (!Number.isFinite(ex) || ex * 1000 <= now) return { url: null, expired: true };
  }
  return { url: parsed.href, expired: false };
}
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const time = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

const nameOf = (user) => user?.nickname?.trim() || user?.name?.trim() || '?';

// `@Nickname` (or `@name`) for each mentioned person → `<@id>`, longest names first so "@Jo"
// doesn't take "@Joel".
function tokeniseMentions(content, mentions) {
  const names = [];
  for (const user of mentions ?? []) {
    for (const name of new Set([user.nickname, user.name].filter(Boolean))) names.push({ name, id: user.id });
  }
  names.sort((a, b) => b.name.length - a.name.length);
  let text = content;
  for (const { name, id } of names) {
    text = text.replace(new RegExp(`(^|[^\\w@<])@${escapeRegExp(name)}(?![\\w])`, 'g'), `$1<@${id}>`);
  }
  return text;
}

const emojiCode = (emoji) => {
  const code = emoji?.code ?? emoji?.name ?? '';
  return emoji?.id && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : null;
};

// `:name:` for each custom emoji in the message → `<:name:id>`.
function tokeniseEmoji(content, inlineEmojis) {
  let text = content;
  for (const emoji of inlineEmojis ?? []) {
    const code = emojiCode(emoji);
    if (!code) continue;
    text = text.replace(new RegExp(`(?<!<):${escapeRegExp(code)}:(?!\\d)`, 'g'), `<:${code}:${emoji.id}>`);
  }
  return text;
}

const textOf = (message) => tokeniseEmoji(tokeniseMentions(message.content ?? '', message.mentions), message.inlineEmojis);

// #rrggbb → a number.
const colour = (hex) => (typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : undefined);

// A bot's rich embed: its text. Links' previews are left out (a person's message with a link:
// the server makes its own; their URLs often differ from the link's, twitter.com for x.com).
function richEmbeds(embeds, content, fromBot) {
  if (!fromBot && /https?:\/\//i.test(content)) return [];
  return (embeds ?? []).filter((e) => !(e.url && content.includes(e.url))).map((e) => ({
    title: e.title || undefined,
    url: isWeb(e.url) ? e.url : undefined,
    description: e.description || undefined,
    color: colour(e.color),
    author: e.author?.name ? { name: e.author.name, url: isWeb(e.author.url) ? e.author.url : undefined } : undefined,
    footer: e.footer?.text ? { text: e.footer.text } : undefined,
    fields: (e.fields ?? []).map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.isInline) })),
  })).filter((e) => e.title || e.description || e.fields.length || e.author);
}

// Where a file is: in the export's media folder (`mediaPath`), or a link the browser may
// download (`remoteUrl`; `expired` when it no longer works).
function whereIs(url, jsonPath) {
  if (!url) return { mediaPath: null, remoteUrl: null, expired: false };
  if (!isWeb(url)) return { mediaPath: resolvePath(jsonPath, url), remoteUrl: null, expired: false };
  const { url: remoteUrl, expired } = downloadable(url);
  return { mediaPath: null, remoteUrl, expired };
}

// A file of a message.
function fileOf(attachment, jsonPath) {
  const url = attachment.url ?? '';
  return {
    filename: attachment.fileName || url.split('/').pop()?.split('?')[0] || 'file',
    size: Number.isSafeInteger(attachment.fileSizeBytes) ? attachment.fileSizeBytes : null,
    ...whereIs(url, jsonPath),
  };
}

// -> { guildName, channel: { sourceId, name, category, thread }, authors: Map(sourceId ->
// { sourceId, name, names, isBot, avatarPath, avatarUrl, messageCount }), emojis: Map(sourceId
// -> { sourceId, name, animated, imagePath, imageUrl, uses }), messages: [...] (oldest first),
// skipped: { [reason]: count } }. `pollText({ question, answer, votes, total })` writes a poll
// result's line.
export function parseExport(json, jsonPath, { pollText }) {
  const authors = new Map();
  const noteUser = (user, { posted = false } = {}) => {
    if (!user?.id) return null;
    let author = authors.get(user.id);
    if (!author) {
      author = {
        sourceId: user.id,
        name: nameOf(user),
        names: [...new Set([user.name, user.nickname].filter(Boolean))],
        isBot: Boolean(user.isBot),
        avatarPath: user.avatarUrl && !isWeb(user.avatarUrl) ? resolvePath(jsonPath, user.avatarUrl) : null,
        avatarUrl: downloadable(user.avatarUrl).url,
        messageCount: 0,
      };
      authors.set(user.id, author);
    }
    if (posted) author.messageCount += 1;
    return author;
  };

  // The custom emoji used in messages and reactions, with their pictures.
  const emojis = new Map();
  const noteEmoji = (emoji) => {
    const name = emojiCode(emoji);
    if (!name) return;
    let known = emojis.get(emoji.id);
    if (!known) {
      const where = whereIs(emoji.imageUrl, jsonPath);
      known = { sourceId: emoji.id, name, animated: Boolean(emoji.isAnimated), imagePath: where.mediaPath, imageUrl: where.remoteUrl, uses: 0 };
      emojis.set(emoji.id, known);
    }
    known.uses += 1;
  };

  // A poll's own message is exported empty; its "poll ended" message names its question.
  const pollQuestions = new Map();
  for (const m of json.messages) {
    if (!POLL_RESULT.has(String(m.type))) continue;
    const field = (name) => m.embeds?.[0]?.fields?.find((f) => f.name === name)?.value;
    if (m.reference?.messageId && field('poll_question_text')) pollQuestions.set(m.reference.messageId, field('poll_question_text'));
  }

  const skipped = {};
  const skip = (reason) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  const messages = [];
  for (const m of json.messages) {
    const type = String(m.type);
    const timestamp = time(m.timestamp);
    if (!timestamp || !m.author?.id) {
      skip('invalid');
      continue;
    }
    let content;
    let embeds = [];
    if (POLL_RESULT.has(type)) {
      const fields = Object.fromEntries((m.embeds?.[0]?.fields ?? []).map((f) => [f.name, f.value]));
      if (!fields.poll_question_text) {
        skip('other');
        continue;
      }
      content = pollText({
        question: fields.poll_question_text,
        answer: fields.victor_answer_text ?? null,
        votes: Number(fields.victor_answer_votes ?? 0),
        total: Number(fields.total_votes ?? 0),
      });
    } else if (KINDS.has(type)) {
      content = textOf(m);
      for (const emoji of m.inlineEmojis ?? []) noteEmoji(emoji);
      embeds = richEmbeds(m.embeds, m.content ?? '', Boolean(m.author.isBot));
      if (!content && pollQuestions.has(m.id)) content = `📊 ${pollQuestions.get(m.id)}`;
    } else {
      skip('system');
      continue;
    }

    const attachments = (m.attachments ?? []).map((a) => fileOf(a, jsonPath));
    for (const sticker of m.stickers ?? []) {
      attachments.push({
        filename: `${sticker.name || 'sticker'}.${sticker.format === 'Gif' ? 'gif' : 'png'}`,
        size: null,
        ...whereIs(sticker.sourceUrl, jsonPath),
      });
    }
    // A forward: our own forward format (utils/forwardMarkup.js), its files with it.
    if (m.forwardedMessage) {
      const at = time(m.forwardedMessage.timestamp);
      const inner = textOf({ ...m.forwardedMessage, mentions: m.mentions, inlineEmojis: m.forwardedMessage.inlineEmojis ?? m.inlineEmojis });
      content = `fwd:v1:${JSON.stringify(at ? { t: Math.floor(at / 1000) } : {})}\n${inner}`;
      for (const a of m.forwardedMessage.attachments ?? []) attachments.push(fileOf(a, jsonPath));
      for (const emoji of m.forwardedMessage.inlineEmojis ?? []) noteEmoji(emoji);
    }

    noteUser(m.author, { posted: true });
    for (const user of m.mentions ?? []) noteUser(user);
    const reactions = (m.reactions ?? []).map((r) => {
      for (const user of r.users ?? []) noteUser(user);
      const custom = Boolean(r.emoji?.id);
      if (custom) noteEmoji(r.emoji);
      return {
        ...(custom ? { customName: r.emoji.code || r.emoji.name, customId: r.emoji.id } : { emoji: r.emoji?.name }),
        count: r.count,
        userSourceIds: (r.users ?? []).map((u) => u.id),
      };
    }).filter((r) => (r.customName || r.emoji) && r.count > 0);
    const interaction = COMMAND_KINDS.has(type) && m.interaction?.name && m.interaction.user?.id
      ? (noteUser(m.interaction.user), { name: m.interaction.name, userSourceId: m.interaction.user.id })
      : undefined;

    messages.push({
      sourceId: m.id,
      authorSourceId: m.author.id,
      timestamp,
      editedTimestamp: time(m.timestampEdited) ?? undefined,
      pinned: Boolean(m.isPinned),
      content,
      replyToSourceId: m.reference?.messageId && m.reference.type !== 'Forward' && !POLL_RESULT.has(type) ? m.reference.messageId : undefined,
      attachments,
      embeds,
      reactions,
      interaction,
    });
  }
  // Ids are numbers that grow (snowflakes): the tie-break within a millisecond.
  const byId = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
  messages.sort((a, b) => a.timestamp - b.timestamp || byId(a.sourceId, b.sourceId));

  const channelType = String(json.channel.type);
  return {
    guildName: json.guild?.name ?? null,
    channel: {
      sourceId: json.channel.id,
      name: json.channel.name ?? json.channel.id,
      category: json.channel.category ?? null,
      thread: THREAD_TYPES.has(channelType),
    },
    authors,
    emojis,
    messages,
    skipped,
  };
}
