import React from 'react';
import { setThemeChoice, useTheme } from '../utils/theme';

const OPTIONS = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'Match system' },
];

// Settings → Appearance: light or dark, on this device only (utils/theme).
export default function ThemeSettings() {
  const { choice, theme } = useTheme();

  // Arrow keys move between the options, like radio buttons.
  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const index = OPTIONS.findIndex((o) => o.value === choice);
    const next = OPTIONS[(index + step + OPTIONS.length) % OPTIONS.length];
    setThemeChoice(next.value);
    e.currentTarget.querySelector(`[data-value="${next.value}"]`)?.focus();
  };

  return (
    <div className="settings-card">
      <h5>Theme</h5>
      <div className="theme-options" role="radiogroup" aria-label="Theme" onKeyDown={onKeyDown}>
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={choice === option.value}
            tabIndex={choice === option.value ? 0 : -1}
            data-value={option.value}
            className={`theme-option${choice === option.value ? ' selected' : ''}`}
            onClick={() => setThemeChoice(option.value)}
          >
            <span className={`theme-preview theme-preview-${option.value}`} aria-hidden="true">
              <span className="theme-preview-side" />
              <span className="theme-preview-chat">
                <span className="theme-preview-line" />
                <span className="theme-preview-line short" />
                <span className="theme-preview-box" />
              </span>
            </span>
            {option.label}
          </button>
        ))}
      </div>
      <p className="vc-hint">
        {choice === 'system' && <>Your system is using {theme} mode now. </>}
        Saved on this device only. On iPhones and iPads the keyboard matches too.
      </p>
    </div>
  );
}
