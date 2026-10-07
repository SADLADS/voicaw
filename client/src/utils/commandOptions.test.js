import { describe, expect, it } from 'vitest';
import { commandEntries, groupCommandsByBot, searchCommands } from './commandOptions';

const bot = (id) => ({ id, name: `bot ${id}` });
const command = (id, name, botId, options) => ({ id, name, type: 1, description: name, bot: bot(botId), options });

describe('groupCommandsByBot', () => {
  it('makes one section per bot, bots in the order of their best match', () => {
    const entries = commandEntries([
      command('1', 'ping', 'b'),
      command('2', 'play', 'a'),
      command('3', 'pause', 'a'),
      command('4', 'poll', 'b'),
    ]);
    const sections = groupCommandsByBot(searchCommands(entries, 'p', Infinity));
    expect(sections.map((s) => s.bot.id)).toEqual(['b', 'a']);
    expect(sections.map((s) => s.entries.map((e) => e.name))).toEqual([['ping', 'poll'], ['play', 'pause']]);
  });

  it('keeps every match when there is no limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => command(String(i), `cmd${i}`, 'a'));
    expect(searchCommands(commandEntries(many), 'cmd', Infinity)).toHaveLength(30);
  });

  it('keeps subcommands under their bot', () => {
    const admin = command('1', 'admin', 'a', [{ type: 1, name: 'ban', description: 'Ban' }, { type: 1, name: 'kick', description: 'Kick' }]);
    const sections = groupCommandsByBot(commandEntries([admin]));
    expect(sections).toHaveLength(1);
    expect(sections[0].entries.map((e) => e.name)).toEqual(['admin ban', 'admin kick']);
  });
});
