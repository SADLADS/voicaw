// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rehypeHighlightShared } from '../utils/rehypeHighlightShared';
import CodeBlock from './CodeBlock';

const draw = (text) => render(
  <ReactMarkdown rehypePlugins={[rehypeHighlightShared]} components={{ pre: CodeBlock }}>{text}</ReactMarkdown>,
);

describe('CodeBlock', () => {
  let writeText;
  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('copies the code as typed: highlighted, several lines, no newline added', async () => {
    draw('```js\nconst a = 1;\n\n  return "<b>";\n```');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy code' })); });
    expect(writeText).toHaveBeenCalledWith('const a = 1;\n\n  return "<b>";');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('copies only its own block', async () => {
    draw('```\nfirst\n```\n\n```\nsecond\n```');
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Copy code' })[1]); });
    expect(writeText).toHaveBeenCalledWith('second');
  });

  it('keeps inline code without a button', () => {
    draw('some `code` here');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('goes back to Copy after a moment', async () => {
    vi.useFakeTimers();
    draw('```\nx\n```');
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
  });

  it('says so when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    draw('```\nx\n```');
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(screen.getByRole('button', { name: "Couldn't copy the code" })).toBeTruthy();
  });

  it("doesn't count as a click on the message", async () => {
    const onRow = vi.fn();
    render(<div onClick={onRow}><CodeBlock><code>x</code></CodeBlock></div>);
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(onRow).not.toHaveBeenCalled();
  });
});
