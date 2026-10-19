import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import * as icons from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';

// Icon draws the same markup as Font Awesome's own component (kept as a dev dependency for this).
const same = (props) => expect(renderToStaticMarkup(<Icon {...props} />)).toBe(renderToStaticMarkup(<FontAwesomeIcon {...props} />));

describe('Icon', () => {
  it('draws every solid icon as FontAwesomeIcon does', () => {
    const all = Object.values(icons).filter((i) => i?.iconName && Array.isArray(i.icon));
    expect(all.length).toBeGreaterThan(1000);
    for (const icon of all) same({ icon });
  });

  it('takes the props the app uses as FontAwesomeIcon does', () => {
    const icon = icons.faReply;
    same({ icon, className: 'a b' });
    same({ icon, fixedWidth: true });
    same({ icon, spin: true, size: 'lg', style: { color: 'red' } });
    same({ icon, size: '2x', className: 'x' });
    same({ icon, title: 'Reply' });
    same({ icon, 'aria-hidden': 'true', className: 'y' });
    same({ icon, 'aria-label': 'Reply' });
    same({ icon, fixedWidth: true, className: 'c', 'aria-hidden': true });
  });

  it('draws nothing without an icon', () => {
    expect(renderToStaticMarkup(<Icon icon={undefined} />)).toBe('');
  });
});
