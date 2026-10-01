// Twemoji file names: code points without leading zeros, joined by "-", dropping FE0F unless
// the sequence has a zero-width joiner. One sequence doesn't follow the rule. Imports
// nothing, so the build (vite.config.js) can use it too.
const FILE_EXCEPTIONS = { '1f441-fe0f-200d-1f5e8-fe0f': '1f441-200d-1f5e8' };

export function twemojiFile(unified) {
  if (FILE_EXCEPTIONS[unified]) return FILE_EXCEPTIONS[unified];
  const parts = unified.split('-').map((cp) => cp.replace(/^0+(?=.)/, ''));
  return (unified.includes('200d') ? parts : parts.filter((cp) => cp !== 'fe0f')).join('-');
}
