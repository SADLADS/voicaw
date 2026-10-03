import { t } from '../i18n';

export function formatBytes(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return t('media.size.bytes', { size: bytes });
  const units = ['media.size.kilobytes', 'media.size.megabytes', 'media.size.gigabytes'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return t(units[unit], { size: value.toFixed(value < 10 ? 1 : 0) });
}
