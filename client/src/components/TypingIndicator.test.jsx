// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import TypingIndicator from './TypingIndicator';
import { applyTyping, resetTyping } from '../utils/typing';

vi.mock('../utils/api', () => ({ default: { get: vi.fn(() => new Promise(() => {})) } }));

const NAMES = { 1: 'Ann', 2: 'Bea', 3: 'Cal', 4: 'Dan' };

function typing(...userIds) {
  act(() => userIds.forEach((userId) => applyTyping({ chatId: 'channel-1', userId })));
}

describe('TypingIndicator', () => {
  afterEach(() => act(() => resetTyping()));

  it('names up to three people in bold, then gives up', () => {
    const { container } = render(<TypingIndicator chatId="channel-1" names={NAMES} />);
    const text = () => container.querySelector('.typing-text')?.textContent ?? '';
    const bold = () => [...container.querySelectorAll('.typing-text strong')].map((b) => b.textContent);

    expect(text()).toBe('');
    typing(1);
    expect(text()).toBe('Ann is typing…');
    expect(bold()).toEqual(['Ann']);
    typing(2);
    expect(text()).toBe('Ann and Bea are typing…');
    typing(3);
    expect(text()).toBe('Ann, Bea and Cal are typing…');
    expect(bold()).toEqual(['Ann', 'Bea', 'Cal']);
    typing(4);
    expect(text()).toBe('Several people are typing…');
  });
});
