import { memo } from 'react';

// A Font Awesome icon (an icon object from @fortawesome/free-solid-svg-icons), drawn as the same
// <svg> as their FontAwesomeIcon, whose CSS (svg-inline--fa, fa-fw, fa-spin...) main.jsx loads.
// Theirs builds each icon through the library's whole pipeline (parsing, an abstract tree,
// converting it to React) on every render, which a phone felt in long lists of icons; this
// only draws the path. As theirs, a title isn't drawn and an icon that isn't one draws nothing.
export const Icon = memo(function Icon({ icon, className, fixedWidth = false, spin = false, size, style, ...rest }) {
  if (!icon?.icon) return null;
  const attributes = { ...rest };
  delete attributes.title;
  const [width, height, , , path] = icon.icon;
  const classes = [
    'svg-inline--fa', `fa-${icon.iconName}`,
    fixedWidth && 'fa-fw', spin && 'fa-spin', size && `fa-${size}`,
  ].filter(Boolean).join(' ');
  return (
    <svg
      data-prefix={icon.prefix}
      data-icon={icon.iconName}
      className={`${classes} ${className ?? ''}`}
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={style}
      {...attributes}
    >
      <path fill="currentColor" d={path} />
    </svg>
  );
});
