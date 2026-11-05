import { useEffect, useRef, useState } from 'react';
import { faCheck, faCopy, faXmark } from '@fortawesome/free-solid-svg-icons';
import { t } from '../i18n';
import { Icon } from './Icon';

const RESULT_MS = 2000;

// A ``` code block in drawn markdown, with a button copying its code. The text is read from the
// page when clicked, so drawing thousands of these (markdown is cached) keeps no copy of it, and
// highlighting's spans don't matter. The button sits in the <pre> because the <code> is what
// scrolls sideways, so it stays in the corner. Icon only, so selecting the message's text
// doesn't pick it up.
export default function CodeBlock({ children }) {
  const pre = useRef(null);
  const [result, setResult] = useState(null); // 'copied' or 'failed', for a moment
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (e) => {
    e.stopPropagation(); // a tap isn't a tap on the message row
    let outcome = 'copied';
    try {
      const code = pre.current.querySelector('code')?.textContent ?? '';
      // Markdown ends a block's text with a newline nobody typed.
      await navigator.clipboard.writeText(code.replace(/\n$/, ''));
    } catch {
      outcome = 'failed';
    }
    setResult(outcome);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(null), RESULT_MS);
  };

  const label = result === 'copied' ? t('common.copied')
    : result === 'failed' ? t('chat.message.copyCodeFailed')
      : t('chat.message.copyCode');
  return (
    <pre ref={pre} className="code-block">
      {children}
      <button
        type="button"
        className={`code-block-copy${result ? ` ${result}` : ''}`}
        title={label}
        aria-label={label}
        onClick={copy}
      >
        <Icon icon={result === 'copied' ? faCheck : result === 'failed' ? faXmark : faCopy} />
      </button>
    </pre>
  );
}
