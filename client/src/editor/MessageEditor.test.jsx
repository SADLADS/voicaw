// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React, { createRef } from 'react';
import { render, act, fireEvent } from '@testing-library/react';
import MessageEditor from './MessageEditor';
import { editorFor } from './editorRegistry';

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

  it('sets and clears its text', () => {
    const { ref } = setup({ initialText: 'start ![a](attachment:5)' });
    expect(ref.current.getText()).toBe('start ![a](attachment:5)');
    act(() => ref.current.setText('new\ntext'));
    expect(ref.current.getText()).toBe('new\ntext');
    act(() => ref.current.clear());
    expect(ref.current.getText()).toBe('');
  });
});
