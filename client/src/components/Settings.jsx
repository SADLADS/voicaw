import React, { useState, useContext, useEffect } from "react";
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass, faSignOutAlt, faXmark } from '@fortawesome/free-solid-svg-icons';
import { InteractionContext, LayoutContext } from '../contexts';
import NotificationSettings from "./NotificationSettings";
import AppUpdateSettings from "./AppUpdateSettings";
import AccountSecuritySettings from "./AccountSecuritySettings";
import AdminSettings from "./AdminSettings";
import DateTimeSettings from "./DateTimeSettings";
import { MAX_PROFILE_PIC_BYTES, uploadProfilePicture } from '../services/profileService';
import { announceProfilePictureChange } from '../utils/profilePicture';

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

function ProfilePictureSettings() {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleFileSelect = (e) => {
    const f = e.target.files[0];
    if (!f || !f.type.startsWith("image/")) {
      setError("Only image files are allowed.");
    } else if (f.size > MAX_PROFILE_PIC_BYTES) {
      setError("That image is too large (max 8 MB).");
    } else {
      setFile(f);
      setError(null);
    }
  };

  const uploadFile = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    setSuccess(false);

    try {
      await uploadProfilePicture(file);
      announceProfilePictureChange();
      setSuccess(true);
      setFile(null);
    } catch (err) {
      setError(err.message || "Upload error");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="settings-card">
      <h5>Change Profile Pic</h5>
      <input
        type="file"
        accept="image/*"   // allow any image type
        onChange={handleFileSelect}
        style={{ marginBottom: "1rem" }}
      />
      <br />
      <button
        className="uploadbutton btn"
        onClick={uploadFile}
        disabled={!file || uploading}
        style={{
          cursor: uploading ? "not-allowed" : "pointer",
        }}
      >
        {uploading ? "Uploading..." : "Upload"}
      </button>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {success && <p style={{ color: "green" }}>Upload successful!</p>}
    </div>
  );
}

// User Settings (/settings): sections in categories, with a column (on top, on a phone) that
// searches them and jumps to one. Sections that don't match the search are hidden, not
// removed, so what's been typed or picked in them stays. `/settings#<section id>` opens
// scrolled to that section. On a computer the column is drawn beside the rail, above the user
// panel (Layout's `settingsNavSlot`).
export default function Settings({ onLogout }) {
  const { interactionMode, setInteractionMode } = useContext(InteractionContext);
  const [query, setQuery] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const location = useLocation();
  const navSlot = useContext(LayoutContext)?.settingsNavSlot ?? null;

  const sections = [
    {
      id: 'profile-picture', category: 'account', title: 'Profile picture',
      keywords: 'avatar photo image upload pic',
      content: <ProfilePictureSettings />,
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

  function jumpTo(id) {
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
                <button key={section.id} type="button" className="settings-nav-item" onClick={() => jumpTo(section.id)}>
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
        {CATEGORIES.map((category) => {
          const inCategory = sections.filter((s) => s.category === category.id);
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
