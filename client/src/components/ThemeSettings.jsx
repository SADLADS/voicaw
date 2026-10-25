import React from 'react';
import { setThemeChoice, useTheme } from '../utils/theme';
import { t } from '../i18n';

const OPTIONS = [
  { value: 'dark', labelKey: 'settings.theme.dark' },
  { value: 'light', labelKey: 'settings.theme.light' },
  { value: 'familiar', labelKey: 'settings.theme.familiar' },
  { value: 'halloween', labelKey: 'settings.theme.halloween' },
  { value: 'slack', labelKey: 'settings.theme.slack' },
  { value: 'system', labelKey: 'settings.theme.system' },
];

// A little picture of a theme in its own colours: data-theme-preview gives it that theme's
// tokens (voicaw.css), so it's drawn from the real values. The rail with the logo, the
// sidebar with the open row, the chat with two lines and the message box with Send.
function ThemeScene({ theme }) {
  return (
    <span className="theme-preview" data-theme-preview={theme}>
      <span className="theme-preview-rail">
        <span className="theme-preview-logo" />
        <span className="theme-preview-icon" />
        <span className="theme-preview-icon" />
      </span>
      <span className="theme-preview-side">
        <span className="theme-preview-row active" />
        <span className="theme-preview-row" />
        <span className="theme-preview-row short" />
      </span>
      <span className="theme-preview-chat">
        <span className="theme-preview-line" />
        <span className="theme-preview-line short" />
        <span className="theme-preview-box" />
      </span>
    </span>
  );
}

// Match system: Dark and Light, split corner to corner.
function ThemePreview({ value }) {
  if (value !== 'system') return <ThemeScene theme={value} />;
  return (
    <span className="theme-preview-system">
      <ThemeScene theme="dark" />
      <ThemeScene theme="light" />
    </span>
  );
}

// Settings → Appearance: the theme, on this device only (utils/theme).
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
      <h5>{t('settings.theme.title')}</h5>
      <div className="theme-options" role="radiogroup" aria-label={t('settings.theme.title')} onKeyDown={onKeyDown}>
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
            <span className="theme-preview-frame" aria-hidden="true">
              <ThemePreview value={option.value} />
            </span>
            {t(option.labelKey)}
          </button>
        ))}
      </div>
      <p className="vc-hint">
        {choice !== 'system' && t('settings.theme.hint')}
        {choice === 'system' && (theme === 'light' ? t('settings.theme.hintSystemLight') : t('settings.theme.hintSystemDark'))}
      </p>
    </div>
  );
}
