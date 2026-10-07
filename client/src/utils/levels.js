import { t } from '../i18n';

// Levels (server/guildLevels.js): each guild's settings come in its layout (`guild.levels`),
// each member's XP in the member list (`xp`). A level is every `xpPerLevel` XP; at 1 the app
// talks only of levels, never XP. Names a guild left empty are the app's own, translated.

// What earns XP, in the order the settings list them (server/guildLevels.js SOURCES).
export const LEVEL_SOURCES = [
  'message', 'replyReceived', 'reactionReceived', 'mentionReceived', 'reactionGiven',
  'threadCreated', 'documentCreated', 'taskCompleted', 'voiceMinute',
];

export const NAME_LIMITS = { xpName: 32, levelName: 32, levelShort: 12 };
export const MAX_XP_PER_LEVEL = 1e6;
export const MAX_SOURCE_XP = 1e6;
export const MAX_COOLDOWN = 3600;

// Whether the guild has levels turned on (and the layout has them at all).
export const levelsOn = (guild) => Boolean(guild?.levels?.enabled);

// Whether XP is shown: not when one XP is one level.
export const showsXp = (settings) => settings.xpPerLevel > 1;

export const xpName = (settings) => settings.xpName || t('levels.defaults.xp');
export const levelName = (settings) => settings.levelName || t('levels.defaults.level');
export const levelShort = (settings) => settings.levelShort || t('levels.defaults.levelShort');

export const levelOf = (xp, settings) => Math.floor((xp ?? 0) / settings.xpPerLevel);

// Where `xp` is within its level: { level, into, needed } (into of needed XP to the next).
export function levelProgress(xp, settings) {
  const total = xp ?? 0;
  return { level: levelOf(total, settings), into: total % settings.xpPerLevel, needed: settings.xpPerLevel };
}

// Short numbers for small spaces: 999, 1.2k, 12k, 100k, 1m, 2.5b, 1t.
export function compactNumber(value) {
  const n = Math.max(0, Math.floor(value ?? 0));
  const units = [[1e12, 't'], [1e9, 'b'], [1e6, 'm'], [1e3, 'k']];
  for (const [size, suffix] of units) {
    if (n >= size) {
      const scaled = n / size;
      // One decimal under 10 (1.2k), none from there (12k, 100k); never rounded up a unit.
      const shown = scaled < 10 ? Math.floor(scaled * 10) / 10 : Math.floor(scaled);
      return `${shown}${suffix}`;
    }
  }
  return String(n);
}

// "12 lvl", "100k lvl": the member list's badge.
export const levelBadge = (level, settings) => t('levels.badge', { level: compactNumber(level), short: levelShort(settings) });
