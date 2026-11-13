// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import PipSettings from './PipSettings';
import { getPipPrefs, setPipPref } from '../utils/pipPrefs';

afterEach(() => {
  cleanup();
  setPipPref('onLeave', true);
  setPipPref('onScroll', false);
  localStorage.clear();
});

describe('Settings → Picture in picture', () => {
  it('keeps videos playing on leaving by default, not on scrolling', () => {
    render(<PipSettings />);
    expect(screen.getByLabelText('Keep videos playing in a corner when I leave the chat')).toBeChecked();
    expect(screen.getByLabelText('Also when I scroll a playing video out of view')).not.toBeChecked();
  });

  it('saves each on this device; scrolling only counts with the first on', () => {
    render(<PipSettings />);
    fireEvent.click(screen.getByLabelText('Also when I scroll a playing video out of view'));
    expect(getPipPrefs().onScroll).toBe(true);
    expect(JSON.parse(localStorage.getItem('pipPrefs'))).toMatchObject({ onLeave: true, onScroll: true });

    fireEvent.click(screen.getByLabelText('Keep videos playing in a corner when I leave the chat'));
    expect(getPipPrefs().onLeave).toBe(false);
    const scroll = screen.getByLabelText('Also when I scroll a playing video out of view');
    expect(scroll).toBeDisabled();
    expect(scroll).not.toBeChecked();
  });
});
