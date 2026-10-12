// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React, { createRef } from 'react';
import { render, act, fireEvent } from '@testing-library/react';
import MessageEditor from './MessageEditor';
import { editorFor } from './editorRegistry';
import { setCustomEmojiBase } from '../emoji/customEmoji';

function setup(props = {}) {
  const ref = createRef();
  const onChange = vi.fn();
  const utils = render(<MessageEditor ref={ref} id="box" placeholder="Say something" onChange={onChange} {...props} />);
  const element = utils.container.querySelector('#box');
  return { ref, onChange, element, ...utils };
}

// A keydown the way the browser sends it to the editable element.
const key = (element, init) => fireEvent.keyDown(element, init);

describe('MessageEditor', () => {
  it('is a labelled textbox showing its placeholder while empty', () => {
    const { element, ref } = setup({ ariaLabel: 'Message' });
    expect(element).toHaveAttribute('contenteditable', 'true');
    expect(element).toHaveAttribute('role', 'textbox');
    expect(element).toHaveAttribute('aria-label', 'Message');
    expect(element).toHaveClass('is-empty');
    expect(element.querySelector('p')).toHaveAttribute('data-placeholder', 'Say something');
    act(() => ref.current.insertText('hi'));
    expect(element).not.toHaveClass('is-empty');
    expect(element.querySelector('p')).not.toHaveAttribute('data-placeholder');
    expect(editorFor(element)).toBe(ref.current);
  });

  it('completes a custom emoji, and shows <:name:id> from text as its image', () => {
    const { ref, element } = setup();
    act(() => ref.current.insertText('hi :blo'));
    act(() => ref.current.replaceBeforeCaretWithCustomEmoji(4, { id: '42', name: 'blob', url: 'https://s3.test/emojis/42' }));
    expect(ref.current.getText()).toBe('hi <:blob:42> ');
    expect(element.querySelector('img.emoji')).toHaveAttribute('src', 'https://s3.test/emojis/42');
    act(() => ref.current.insertText('!'));
    expect(ref.current.getText()).toBe('hi <:blob:42> !');
  });

  it('shows timestamps as they will read, typed, pasted as text or inserted', () => {
    const { ref, element } = setup();
    const unix = Math.floor(Date.now() / 1000) + 8 * 3600 + 60;
    act(() => ref.current.insertText(`at <t:${unix}:R`));
    expect(element.querySelector('.timestamp')).toBeNull();
    act(() => ref.current.insertText('>'));
    expect(element.querySelector('.timestamp')).toHaveTextContent('in 8 hours');
    expect(ref.current.getText()).toBe(`at <t:${unix}:R>`);
    act(() => ref.current.setText(`<t:${unix}:D> and <t:1:x>`));
    expect(element.querySelectorAll('.timestamp')).toHaveLength(1);
    expect(ref.current.getText()).toBe(`<t:${unix}:D> and <t:1:x>`);
    act(() => ref.current.clear());
    act(() => ref.current.insertTimestamp({ unix, style: 't' }));
    expect(ref.current.getText()).toBe(`<t:${unix}:t> `);
  });

  it('keeps a relative timestamp counting', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 9, 10, 0, 0) });
    try {
      const { ref, element } = setup();
      const unix = Math.floor(Date.now() / 1000) + 3 * 3600;
      act(() => ref.current.insertTimestamp({ unix, style: 'R' }));
      expect(element.querySelector('.timestamp')).toHaveTextContent('in 3 hours');
      act(() => vi.advanceTimersByTime(2 * 3600 * 1000));
      expect(element.querySelector('.timestamp')).toHaveTextContent('in 1 hour');
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes a mention, and shows <@id> of people it knows as @name', () => {
    const { ref, element } = setup({ mentionNames: { 7: 'anna' } });
    act(() => ref.current.insertText('hi @an'));
    act(() => ref.current.replaceBeforeCaretWithMention(3, { id: 7, name: 'anna' }));
    expect(ref.current.getText()).toBe('hi <@7> ');
    expect(element.querySelector('.mention')).toHaveTextContent('@anna');
    act(() => ref.current.setText('<@7> <@8>'));
    expect(element.querySelectorAll('.mention')).toHaveLength(1);
    expect(ref.current.getText()).toBe('<@7> <@8>');
  });

  it('shows markdown as it will look, keeping the text exactly as typed', () => {
    const { ref, element } = setup();
    act(() => ref.current.insertText('**hello** *world*'));
    expect(ref.current.getText()).toBe('**hello** *world*');
    expect(element.querySelector('.md-bold')).toHaveTextContent('hello');
    expect(element.querySelector('.md-italic')).toHaveTextContent('world');
    expect([...element.querySelectorAll('.md-syntax')].map((e) => e.textContent)).toEqual(['**', '**', '*', '*']);
    // A chip before it takes one position, so the styling still lines up.
    act(() => ref.current.setText('![a.png](attachment:1) ~~gone~~\n> quote'));
    expect(element.querySelector('.md-strike')).toHaveTextContent('gone');
    expect(element.querySelectorAll('p')[1]).toHaveClass('md-quote');
  });

  it('reports text and the line up to the cursor', () => {
    const { ref, onChange } = setup();
    act(() => ref.current.insertText('hello :smi'));
    expect(onChange).toHaveBeenLastCalledWith({ text: 'hello :smi', beforeCaret: 'hello :smi', docChanged: true });
    act(() => ref.current.replaceBeforeCaret(4, '😄 '));
    expect(ref.current.getText()).toBe('hello 😄 ');
  });

  it('sends on Enter when asked to, and makes a new line with Shift+Enter', () => {
    const onSubmit = vi.fn();
    const { ref, element } = setup({ submitOnEnter: true, onSubmit });
    act(() => ref.current.insertText('one'));
    key(element, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    key(element, { key: 'Enter', shiftKey: true });
    act(() => ref.current.insertText('two'));
    expect(ref.current.getText()).toBe('one\ntwo');
  });

  it('makes a new line on Enter otherwise (mobile)', () => {
    const onSubmit = vi.fn();
    const { ref, element } = setup({ submitOnEnter: false, onSubmit });
    act(() => ref.current.insertText('one'));
    key(element, { key: 'Enter' });
    act(() => ref.current.insertText('two'));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(ref.current.getText()).toBe('one\ntwo');
  });

  it('lets onKeyDown take a key first', () => {
    const onSubmit = vi.fn();
    const { element } = setup({ submitOnEnter: true, onSubmit, onKeyDown: (e) => { if (e.key === 'Enter') e.preventDefault(); } });
    key(element, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('holds attachments as chips, and removes them by id', () => {
    const { ref, element } = setup();
    act(() => ref.current.insertText('look '));
    act(() => ref.current.insertAttachments([{ id: 1, name: 'a.png' }, { id: 2, name: 'b [x].pdf' }]));
    expect(ref.current.getText()).toBe('look ![a.png](attachment:1) ![b \\[x\\].pdf](attachment:2)');
    expect(element.querySelectorAll('.editor-attachment')).toHaveLength(2);
    expect(element.querySelector('.editor-attachment').textContent).toBe('📎 a.png');
    act(() => ref.current.removeAttachment(1));
    expect(ref.current.getText()).toBe('look  ![b \\[x\\].pdf](attachment:2)');
  });

  it('shows custom emoji as images', () => {
    const { ref, element } = setup();
    act(() => ref.current.insertCustomEmoji({ id: '9', name: 'party', url: 'https://s3.test/e/9.png' }));
    expect(element.querySelector('img.emoji')).toHaveAttribute('src', 'https://s3.test/e/9.png');
    expect(ref.current.getText()).toBe('<:party:9>');
  });

  it('refuses edits past maxLength, but not attachments', () => {
    const { ref } = setup({ maxLength: 5 });
    act(() => ref.current.insertText('12345'));
    act(() => ref.current.insertText('6'));
    expect(ref.current.getText()).toBe('12345');
    act(() => ref.current.insertAttachments([{ id: 1, name: 'x' }]));
    expect(ref.current.getText()).toBe('12345![x](attachment:1)');
  });

  it('pastes files to onPasteFiles and everything else as plain text', () => {
    const onPasteFiles = vi.fn();
    const { ref, element } = setup({ onPasteFiles });
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    fireEvent.paste(element, { clipboardData: { files: [file], getData: () => '' } });
    expect(onPasteFiles).toHaveBeenCalledWith([file]);

    fireEvent.paste(element, { clipboardData: { files: [], getData: (type) => (type === 'text/plain' ? 'line 1\r\nline 2' : '<b>bold</b>') } });
    expect(ref.current.getText()).toBe('line 1\nline 2');
  });

  it('copies custom emoji and mentions as message text, so pasting gives them back', () => {
    setCustomEmojiBase('https://s3.test');
    const { ref, element } = setup({ mentionNames: { 2: 'Anna' } });
    act(() => ref.current.insertText('hi :clu'));
    act(() => ref.current.replaceBeforeCaretWithCustomEmoji(4, { id: '42', name: 'clueless', url: 'https://s3.test/emojis/42' }));
    act(() => ref.current.insertText('<@2> '));
    act(() => ref.current.setText(ref.current.getText()));
    key(element, { key: 'a', ctrlKey: true });
    const copied = {};
    const clipboardData = { clearData: () => {}, setData: (type, value) => { copied[type] = value; }, getData: (type) => copied[type] ?? '' };
    fireEvent.copy(element, { clipboardData });
    expect(copied['text/plain']).toBe('hi <:clueless:42> <@2> ');
    fireEvent.paste(element, { clipboardData: { files: [], getData: clipboardData.getData } });
    expect(ref.current.getText()).toBe('hi <:clueless:42> <@2> ');
    expect(element.querySelectorAll('img.emoji')).toHaveLength(1);
    expect(element.querySelector('.editor-mention')).toHaveTextContent('@Anna');
    setCustomEmojiBase('');
  });

  it('sets and clears its text', () => {
    const { ref } = setup({ initialText: 'start ![a](attachment:5)' });
    expect(ref.current.getText()).toBe('start ![a](attachment:5)');
    act(() => ref.current.setText('new\ntext'));
    expect(ref.current.getText()).toBe('new\ntext');
    act(() => ref.current.clear());
    expect(ref.current.getText()).toBe('');
  });
});
