import React, { useState, useContext, useEffect } from "react";
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass, faSignOutAlt, faXmark } from '@fortawesome/free-solid-svg-icons';
import { InteractionContext, LayoutContext } from '../contexts';
import NotificationSettings from "./NotificationSettings";
import AppUpdateSettings from "./AppUpdateSettings";
import AccountSecuritySettings from "./AccountSecuritySettings";
import AdminSettings from "./AdminSettings";
import DateTimeSettings from "./DateTimeSettings";
import EditProfile from "./EditProfile";

const CATEGORIES = [
  { id: 'account', title: 'My Account' },
  { id: 'app', title: 'App Settings' },
  { id: 'admin', title: 'Admin' },
  { id: 'about', title: 'About' },
];

// Whether a section matches the search: every word in its title, keywords or category.
function matches(section, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const category = CATEGORIES.find((c) => c.id === section.category)?.title ?? '';
  const haystack = `${section.title} ${section.keywords} ${category}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// User Settings (/settings): sections in categories, with a column (on top, on a phone) that
// searches them and jumps to one. Sections that don't match the search are hidden, not
// removed, so what's been typed or picked in them stays. `/settings#<section id>` opens
// scrolled to that section. On a computer the column is drawn beside the rail, above the user
// panel (Layout's `settingsNavSlot`). Edit Profile is a page of its own (/settings/profile),
// reached from the column like a section (a section with a `link`).
export default function Settings({ onLogout }) {
  const { interactionMode, setInteractionMode } = useContext(InteractionContext);
  const [query, setQuery] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const onProfilePage = location.pathname.startsWith('/settings/profile');
  const navSlot = useContext(LayoutContext)?.settingsNavSlot ?? null;

  const sections = [
    {
      id: 'edit-profile', category: 'account', title: 'Edit Profile',
      keywords: 'profile picture avatar photo image upload pic display name nickname bio about me custom status',
      link: '/settings/profile',
    },
    {
      id: 'account-security', category: 'account', title: 'Password & recovery code',
      keywords: 'change password security recovery code forgot',
      content: <AccountSecuritySettings />,
    },
    {
      id: 'log-out', category: 'account', title: 'Log out',
      keywords: 'sign out logout leave',
      content: (
        <div className="settings-card">
          <h5>Log Out</h5>
          <div className="mt-auto mb-4">
            <button onClick={onLogout} className="btn btn-sm btn-danger" title="Logout">
              <FontAwesomeIcon icon={faSignOutAlt} />Log out
            </button>
          </div>
        </div>
      ),
    },
    {
      id: 'interaction-mode', category: 'app', title: 'Interaction mode',
      keywords: 'desktop mobile phone touch layout auto',
      content: (
        <div className="settings-card">
          <h5>Interaction Mode</h5>
          <select
            aria-label="Interaction mode"
            value={interactionMode}
            onChange={(e) => setInteractionMode(e.target.value)}
          >
            <option value="desktop">Desktop</option>
            <option value="mobile">Mobile</option>
            <option value="auto">Auto</option>
          </select>
        </div>
      ),
    },
    {
      id: 'date-time', category: 'app', title: 'Date & time',
      keywords: 'locale language date format time format 12-hour 24-hour clock am pm',
      content: <DateTimeSettings />,
    },
    {
      id: 'notifications', category: 'app', title: 'Notifications',
      keywords: 'push alerts previews',
      content: <NotificationSettings />,
    },
    {
      id: 'app-version', category: 'app', title: 'App version',
      keywords: 'update build version reload',
      content: <AppUpdateSettings />,
    },
    {
      // Always there (it asks the server whether you're an admin), shown once you are.
      id: 'admin', category: 'admin', title: 'Admin',
      keywords: 'global admins klipy gif api key',
      available: isAdmin,
      content: <AdminSettings onAvailable={() => setIsAdmin(true)} />,
    },
    {
      id: 'about', category: 'about', title: 'About',
      keywords: 'credits attribution licence license twemoji emoji font klipy',
      content: (
        <div className="settings-card">
          <h5>About</h5>
          <p className="settings-attribution">
            Emoji graphics by <a href="https://github.com/jdecked/twemoji" target="_blank" rel="noreferrer">Twemoji</a>,
            {' '}© Twitter, Inc and other contributors, licensed under{' '}
            <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC-BY 4.0</a>.
            {' '}Emoji font modified from{' '}
            <a href="https://github.com/mrdrogdrog/twemoji-color-font" target="_blank" rel="noreferrer">twemoji-color-font</a>,
            licensed under the{' '}
            <a href="https://openfontlicense.org/open-font-license-official-text/" target="_blank" rel="noreferrer">SIL Open Font License 1.1</a>.
            {' '}GIFs from <a href="https://klipy.com" target="_blank" rel="noreferrer">KLIPY</a>.
          </p>
        </div>
      ),
    },
  ];
  const shown = (section) => section.available !== false && matches(section, query);
  const visible = sections.filter(shown);

  function open(section) {
    if (section.link) navigate(section.link);
    else if (onProfilePage) navigate(`/settings#${section.id}`);
    else document.getElementById(`settings-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // /settings#<id>: scrolled there on arrival.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) document.getElementById(`settings-${id}`)?.scrollIntoView({ block: 'start' });
  }, [location.hash]);

  const nav = (
      <nav className="settings-nav" aria-label="Settings sections">
        <h2 className="settings-header">User Settings</h2>
        <div className="settings-search">
          <FontAwesomeIcon icon={faMagnifyingGlass} className="settings-search-icon" />
          <input
            type="search"
            placeholder="Search settings"
            aria-label="Search settings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
          />
          {query && (
            <button type="button" className="settings-search-clear" aria-label="Clear search" onClick={() => setQuery('')}>
              <FontAwesomeIcon icon={faXmark} />
            </button>
          )}
        </div>
        {CATEGORIES.map((category) => {
          const items = visible.filter((s) => s.category === category.id);
          if (!items.length) return null;
          return (
            <div key={category.id} className="settings-nav-group">
              <div className="settings-nav-category">{category.title}</div>
              {items.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={`settings-nav-item${onProfilePage && section.link === '/settings/profile' ? ' active' : ''}`}
                  aria-current={onProfilePage && section.link === '/settings/profile' ? 'page' : undefined}
                  onClick={() => open(section)}
                >
                  {section.title}
                </button>
              ))}
            </div>
          );
        })}
        {!visible.length && <p className="settings-nav-empty">No settings match “{query}”.</p>}
      </nav>
  );

  return (
    <div className="settings-page">
      {navSlot ? createPortal(nav, navSlot) : nav}

      <div className="settings-content">
        {onProfilePage && <EditProfile />}
        {!onProfilePage && CATEGORIES.map((category) => {
          const inCategory = sections.filter((s) => s.category === category.id && !s.link);
          return (
            <section key={category.id} className="settings-category" hidden={!inCategory.some(shown)} aria-label={category.title}>
              <h3 className="settings-category-title">{category.title}</h3>
              {inCategory.map((section) => (
                <div key={section.id} id={`settings-${section.id}`} className="settings-section" hidden={!shown(section)}>
                  {section.content}
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
