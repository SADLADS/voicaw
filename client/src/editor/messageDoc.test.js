import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { deleteWord, docToText, sliceToText, textToDoc, textBeforeCaret, OBJECT_CHAR, schema } from './messageDoc';

const emojiUrl = (id) => `https://s3.test/emoji/${id}.png`;

describe('messageDoc', () => {
  it('round-trips message text, lines included', () => {
    for (const text of ['', 'hi', 'one\ntwo\n\nfour', 'emoji 🏳️‍🌈 stay text', 'a ![b](https://x/y.bin#k=1) c']) {
      expect(docToText(textToDoc(text))).toBe(text);
    }
  });

  it('turns attachment placeholders into chips and back', () => {
    const doc = textToDoc('look ![cat\\_1.png](attachment:3) and ![dog.png](attachment:4)');
    const chips = [];
    doc.descendants((n) => { if (n.type === schema.nodes.attachment) chips.push(n.attrs); });
    expect(chips).toEqual([{ id: 3, name: 'cat_1.png' }, { id: 4, name: 'dog.png' }]);
    expect(docToText(doc)).toBe('look ![cat\\_1.png](attachment:3) and ![dog.png](attachment:4)');
  });

  it("turns a sent message's attachments into chips, keeping their links exactly", () => {
    const sent = '![IMG\\_9342.jpg](https://media.test/uploads/3d.bin#v=1&k=KEY&t=image%2Fjpeg&s=5&w=2&h=1)';
    const text = `look ${sent}\n![](https://example.com/a.png) and ![draft.png](attachment:2)`;
    const doc = textToDoc(text);
    const chips = [];
    doc.descendants((n) => { if (n.type === schema.nodes.sentAttachment) chips.push(n.attrs); });
    expect(chips).toEqual([
      { name: 'IMG_9342.jpg', markup: sent },
      { name: '', markup: '![](https://example.com/a.png)' },
    ]);
    expect(docToText(doc)).toBe(text);
  });

  it('turns custom emoji into images when their URL is known', () => {
    const doc = textToDoc('hi <:party:42> <:gone:7>', { resolveCustomEmoji: (id) => (id === '42' ? emojiUrl(id) : null) });
    const emoji = [];
    doc.descendants((n) => { if (n.type === schema.nodes.customEmoji) emoji.push(n.attrs); });
    expect(emoji).toEqual([{ id: '42', name: 'party', url: emojiUrl('42') }]);
    expect(docToText(doc)).toBe('hi <:party:42> <:gone:7>');
  });

  it('copies a selection as message text, objects included', () => {
    const doc = textToDoc('one <:party:42> <@2>\ntwo <#5> end', {
      resolveCustomEmoji: emojiUrl, resolveMention: () => 'Anna', resolveChannel: () => ({ name: 'general' }),
    });
    expect(sliceToText(doc.slice(0, doc.content.size))).toBe('one <:party:42> <@2>\ntwo <#5> end');
    // From inside the first line to inside the second.
    expect(sliceToText(doc.slice(5, doc.child(0).nodeSize + 5))).toBe('<:party:42> <@2>\ntwo ');
  });

  it('gives the current line up to the cursor, with objects as one character', () => {
    const doc = textToDoc('first\nsay ![a](attachment:1) :smi and more');
    let state = EditorState.create({ doc });
    const line = doc.child(1);
    const lineStart = doc.child(0).nodeSize + 1;
    const cursor = lineStart + 'say '.length + 1 + ' :smi'.length;
    state = state.apply(state.tr.setSelection(TextSelection.create(doc, cursor)));
    expect(line.childCount).toBe(3);
    expect(textBeforeCaret(state)).toBe(`say ${OBJECT_CHAR} :smi`);
  });
});

describe('messageDoc mentions', () => {
  it('turns mentions of known people into @name nodes and back', () => {
    const doc = textToDoc('hi <@2> and <@9>', { resolveMention: (id) => ({ 2: 'Anna' })[id] });
    const mentions = [];
    doc.descendants((n) => { if (n.type === schema.nodes.mention) mentions.push(n.attrs); });
    // Someone unknown stays as typed.
    expect(mentions).toEqual([{ id: '2', name: 'Anna' }]);
    expect(docToText(doc)).toBe('hi <@2> and <@9>');
  });

  it('turns role mentions into nodes with their colour, and back', () => {
    const doc = textToDoc('<@&4> go', { resolveRole: (id) => ({ 4: { name: 'Mods', color: '#e91e63' } })[id] });
    const roles = [];
    doc.descendants((n) => { if (n.type === schema.nodes.roleMention) roles.push(n.attrs); });
    expect(roles).toEqual([{ id: '4', name: 'Mods', color: '#e91e63' }]);
    expect(docToText(doc)).toBe('<@&4> go');
  });

  it('turns channel mentions of known channels into #name nodes and back', () => {
    const doc = textToDoc('see <#5> and <#6>', { resolveChannel: (id) => ({ 5: { name: 'general' } })[id] });
    const channels = [];
    doc.descendants((n) => { if (n.type === schema.nodes.channelMention) channels.push(n.attrs); });
    expect(channels).toEqual([{ id: '5', name: 'general' }]);
    expect(docToText(doc)).toBe('see <#5> and <#6>');
  });
});

describe('deleteWord', () => {
  // Runs deleteWord(dir) with the cursor at `cursor` characters into the first line.
  function run(text, cursor, dir) {
    let state = EditorState.create({ doc: textToDoc(text) });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + cursor)));
    let next = state;
    const handled = deleteWord(dir)(state, (tr) => { next = state.apply(tr); });
    return handled ? docToText(next.doc) : null;
  }
  const chip = '![image.png](attachment:3)';

  it('deletes the word before the cursor and not a chip in front of it', () => {
    // Chip, then "Hello": the chip is one position.
    expect(run(`${chip}Hello`, 6, -1)).toBe(chip);
    expect(run(`${chip} Hello world`, 13, -1)).toBe(`${chip} Hello `);
    expect(run(`${chip} Hello`, 7, -1)).toBe(`${chip} `);
  });

  it('takes a chip only when no text is between it and the cursor', () => {
    expect(run(`a ${chip} `, 4, -1)).toBe('a ');
    expect(run(`a ${chip}`, 3, -1)).toBe('a ');
  });

  it('stops at punctuation and leaves line starts to the base keymap', () => {
    expect(run('one, two', 4, -1)).toBe('one two');
    expect(run('one, two', 3, -1)).toBe(', two');
    expect(run('one,two', 7, -1)).toBe('one,');
    expect(run('hi', 0, -1)).toBeNull();
  });

  it('deletes forwards the same way', () => {
    expect(run(`Hello${chip}`, 0, 1)).toBe(chip);
    expect(run(`ab  cd ${chip}`, 2, 1)).toBe(`ab ${chip}`);
    expect(run('hi', 2, 1)).toBeNull();
  });
});
