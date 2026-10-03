// What a login session's user agent (server/sessions.js) says about the device, for Settings →
// Devices: { name: 'Chrome on Windows', kind: 'desktop' | 'mobile' | 'app' }. A guess from
// the browser's own description, good enough to tell your devices apart.
import { t } from '../i18n';

const BROWSERS = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS = [
  [/Windows/, 'Windows'],
  [/Android/, 'Android'],
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

const find = (list, ua) => list.find(([pattern]) => pattern.test(ua))?.[1] ?? null;

export function describeDevice(userAgent) {
  const ua = userAgent ?? '';
  const system = find(SYSTEMS, ua);
  if (/Electron\//.test(ua)) {
    return { name: system ? t('settings.devices.desktopAppOn', { system }) : t('settings.devices.desktopApp'), kind: 'app' };
  }
  const kind = /Mobi|Android|iPhone|iPad/.test(ua) ? 'mobile' : 'desktop';
  const browser = find(BROWSERS, ua);
  if (browser && system) return { name: t('settings.devices.browserOn', { browser, system }), kind };
  return { name: browser ?? system ?? t('settings.devices.unknown'), kind };
}
