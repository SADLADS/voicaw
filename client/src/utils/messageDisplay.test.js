// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyMessageDisplay, getMessageDisplay, setMessageDisplay } from './messageDisplay';

describe('message display', () => {
  it('is cozy by default, and compact once chosen: kept on this device and put on <html>', () => {
    expect(getMessageDisplay()).toBe('cozy');
    applyMessageDisplay();
    expect(document.documentElement.dataset.messageDisplay).toBe('cozy');

    setMessageDisplay('compact');
    expect(getMessageDisplay()).toBe('compact');
    expect(localStorage.getItem('messageDisplay')).toBe('compact');
    expect(document.documentElement.dataset.messageDisplay).toBe('compact');

    setMessageDisplay('nonsense');
    expect(getMessageDisplay()).toBe('cozy');
    expect(localStorage.getItem('messageDisplay')).toBeNull();
    expect(document.documentElement.dataset.messageDisplay).toBe('cozy');
  });
});
