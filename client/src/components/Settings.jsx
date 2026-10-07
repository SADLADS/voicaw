import React, { useState, useContext, useEffect } from "react";
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass, faPuzzlePiece, faSignOutAlt, faXmark } from '@fortawesome/free-solid-svg-icons';
import { InteractionContext, LayoutContext } from '../contexts';
import NotificationSettings from "./NotificationSettings";
import ReactionNotificationSettings from "./ReactionNotificationSettings";
import AppUpdateSettings from "./AppUpdateSettings";
import DeveloperSettings from './DeveloperSettings';
import AccountSecuritySettings from "./AccountSecuritySettings";
import DeleteAccountSettings from "./DeleteAccountSettings";
import DeviceSettings from "./DeviceSettings";
import AdminSettings from "./AdminSettings";
import DateTimeSettings from "./DateTimeSettings";
import SpellcheckSettings from "./SpellcheckSettings";
import PrivacySettings from "./PrivacySettings";
import BlockedUsers from './BlockedUsers';
import AuthorisedApps from './AuthorisedApps';
import AdminReports from './AdminReports';
import ContentSettings from "./ContentSettings";
import ThemeSettings from "./ThemeSettings";
import LanguageSettings from "./LanguageSettings";
import SoundSettings from "./SoundSettings";
import VoiceSettings from "./VoiceSettings";
import DesktopAppSettings from "./DesktopAppSettings";
import { isDesktopApp } from '../utils/desktop';
import AndroidAppSettings from './AndroidAppSettings';
import { isAndroidApp } from '../utils/android';
import EditProfile from "./EditProfile";
import Avatar from "./Avatar";
import { useAuth } from '../hooks/useAuth';
import { nameOf, useProfiles } from '../utils/profiles';
import { Trans } from 'react-i18next';
import { t } from '../i18n';

const CATEGORIES = [
  { id: 'account', titleKey: 'settings.categories.account' },
  { id: 'app', titleKey: 'settings.categories.app' },
  { id: 'developers', titleKey: 'settings.categories.developers' },
  { id: 'admin', titleKey: 'settings.categories.admin' },
  { id: 'about', titleKey: 'settings.categories.about' },
];

// Whether a section matches the search: every word in its title, keywords or category.
function matches(section, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const categoryKey = CATEGORIES.find((c) => c.id === section.category)?.titleKey;
  const category = categoryKey ? t(categoryKey) : '';
  const haystack = `${section.title} ${section.keywords} ${category}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// Settings (/settings): sections in categories, with a column (on top, on a phone) that
// searches them and jumps to one. Sections that don't match the search are hidden, not
// removed, so what's been typed or picked in them stays. `/settings#<section id>` opens
// scrolled to that section. On a computer the column is drawn beside the rail, above the user
// panel (Layout's `settingsNavSlot`). Edit Profile is a page of its own (/settings/profile),
// reached from the card with your picture and name at the top of the column.
export default function Settings({ onLogout }) {
  useProfiles();
  const { user } = useAuth() ?? {};
  const [query, setQuery] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const onProfilePage = location.pathname.startsWith('/settings/profile');
  const navSlot = useContext(LayoutContext)?.settingsNavSlot ?? null;
  const { isMobile } = useContext(InteractionContext);

  const sections = [
    {
      id: 'account-security', category: 'account', title: t('settings.sections.accountSecurity.title'),
      keywords: t('settings.sections.accountSecurity.keywords'),
      content: <AccountSecuritySettings />,
    },
    {
      id: 'devices', category: 'account', title: t('settings.sections.devices.title'),
      keywords: t('settings.sections.devices.keywords'),
      content: <DeviceSettings />,
    },
    {
      id: 'log-out', category: 'account', title: t('settings.sections.logOut.title'),
      keywords: t('settings.sections.logOut.keywords'),
      content: (
        <div className="settings-card">
          <h5>{t('settings.logOut.title')}</h5>
          <div className="mt-auto mb-4">
            <button onClick={onLogout} className="btn btn-sm btn-danger" title={t('settings.logOut.buttonTitle')}>
              <FontAwesomeIcon icon={faSignOutAlt} />{t('settings.logOut.button')}
            </button>
          </div>
        </div>
      ),
    },
    {
      id: 'delete-account', category: 'account', title: t('settings.sections.deleteAccount.title'),
      keywords: t('settings.sections.deleteAccount.keywords'),
      content: <DeleteAccountSettings onDeleted={onLogout} />,
    },
    {
      id: 'appearance', category: 'app', title: t('settings.sections.appearance.title'),
      keywords: t('settings.sections.appearance.keywords'),
      content: <ThemeSettings />,
    },
    {
      id: 'language', category: 'app', title: t('settings.sections.language.title'),
      keywords: t('settings.sections.language.keywords'),
      content: <LanguageSettings />,
    },
    {
      id: 'date-time', category: 'app', title: t('settings.sections.dateTime.title'),
      keywords: t('settings.sections.dateTime.keywords'),
      content: <DateTimeSettings />,
    },
    {
      id: 'spellcheck', category: 'app', title: t('settings.sections.spellcheck.title'),
      keywords: t('settings.sections.spellcheck.keywords'),
      // Phones check spelling in their own keyboard.
      available: !isMobile,
      content: <SpellcheckSettings />,
    },
    {
      id: 'privacy', category: 'app', title: t('settings.sections.privacy.title'), icon: faPuzzlePiece,
      keywords: t('settings.sections.privacy.keywords'),
      content: <PrivacySettings />,
    },
    {
      id: 'blocked', category: 'app', title: t('settings.sections.blocked.title'),
      keywords: t('settings.sections.blocked.keywords'),
      content: <BlockedUsers />,
    },
    {
      id: 'authorised-apps', category: 'app', title: t('settings.sections.authorisedApps.title'),
      keywords: t('settings.sections.authorisedApps.keywords'),
      content: <AuthorisedApps />,
    },
    {
      id: 'content', category: 'app', title: t('settings.sections.content.title'),
      keywords: t('settings.sections.content.keywords'),
      content: <ContentSettings />,
    },
    {
      id: 'notifications', category: 'app', title: t('settings.sections.notifications.title'),
      keywords: t('settings.sections.notifications.keywords'),
      content: (
        <>
          <NotificationSettings />
          <ReactionNotificationSettings />
        </>
      ),
    },
    {
      id: 'sounds', category: 'app', title: t('settings.sections.sounds.title'),
      keywords: t('settings.sections.sounds.keywords'),
      content: <SoundSettings />,
    },
    {
      id: 'voice-video', category: 'app', title: t('settings.sections.voiceVideo.title'),
      keywords: t('settings.sections.voiceVideo.keywords'),
      content: <VoiceSettings />,
    },
    {
      id: 'desktop-app', category: 'app', title: t('settings.sections.desktopApp.title'),
      keywords: t('settings.sections.desktopApp.keywords'),
      available: isDesktopApp(),
      content: isDesktopApp() ? <DesktopAppSettings /> : null,
    },
    {
      id: 'android-app', category: 'app', title: t('settings.sections.androidApp.title'),
      keywords: t('settings.sections.androidApp.keywords'),
      available: isAndroidApp(),
      content: isAndroidApp() ? <AndroidAppSettings /> : null,
    },
    {
      id: 'app-version', category: 'app', title: t('settings.sections.appVersion.title'),
      keywords: t('settings.sections.appVersion.keywords'),
      content: <AppUpdateSettings />,
    },
    {
      id: 'developer-portal', category: 'developers', title: t('settings.sections.developerPortal.title'),
      keywords: t('settings.sections.developerPortal.keywords'),
      content: <DeveloperSettings />,
    },
    {
      // Always there (it asks the server whether you're an admin), shown once you are.
      id: 'admin', category: 'admin', title: t('settings.sections.admin.title'),
      keywords: t('settings.sections.admin.keywords'),
      available: isAdmin,
      content: <AdminSettings onAvailable={() => setIsAdmin(true)} />,
    },
    {
      // Reports and suspended accounts (AdminReports.jsx), for admins only like the one above.
      id: 'reports', category: 'admin', title: t('settings.sections.reports.title'),
      keywords: t('settings.sections.reports.keywords'),
      available: isAdmin,
      content: isAdmin ? <AdminReports /> : null,
    },
    {
      id: 'about', category: 'about', title: t('settings.sections.about.title'),
      keywords: t('settings.sections.about.keywords'),
      content: (
        <div className="settings-card">
          <h5>{t('settings.about.title')}</h5>
          <p className="settings-attribution">
            <Trans
              i18nKey="settings.about.attribution"
              components={{
                twemoji: <a href="https://github.com/jdecked/twemoji" target="_blank" rel="noreferrer" />,
                ccby: <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" />,
                font: <a href="https://github.com/mrdrogdrog/twemoji-color-font" target="_blank" rel="noreferrer" />,
                ofl: <a href="https://openfontlicense.org/open-font-license-official-text/" target="_blank" rel="noreferrer" />,
                klipy: <a href="https://klipy.com" target="_blank" rel="noreferrer" />,
              }}
            />
          </p>
          {/* On voicaw.com (website/src/legal); Google Play wants the privacy policy in the app too. */}
          <p className="settings-policy-links">
            <a href="https://voicaw.com/privacy/" target="_blank" rel="noreferrer">{t('settings.about.privacy')}</a>
            <a href="https://voicaw.com/terms/" target="_blank" rel="noreferrer">{t('settings.about.terms')}</a>
            <a href="https://voicaw.com/delete-account/" target="_blank" rel="noreferrer">{t('settings.about.deleteAccount')}</a>
          </p>
        </div>
      ),
    },
  ];
  const shown = (section) => section.available !== false && matches(section, query);
  const visible = sections.filter(shown);

  function open(section) {
    if (onProfilePage) navigate(`/settings#${section.id}`);
    else document.getElementById(`settings-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // /settings#<id>: scrolled there on arrival.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) document.getElementById(`settings-${id}`)?.scrollIntoView({ block: 'start' });
  }, [location.hash]);

  const nav = (
      <nav className="settings-nav" aria-label={t('settings.nav.label')}>
        <h2 className="settings-header">{t('common.settings')}</h2>
        {user && (
          <button
            type="button"
            className={`settings-profile-link${onProfilePage ? ' active' : ''}`}
            aria-current={onProfilePage ? 'page' : undefined}
            onClick={() => navigate('/settings/profile')}
          >
            <Avatar userId={user.id} className="settings-profile-avatar" />
            <span className="settings-profile-text">
              <span className="settings-profile-name">{nameOf(user)}</span>
              <span className="settings-profile-action">{t('settings.nav.editProfile')}</span>
            </span>
          </button>
        )}
        <div className="settings-search">
          <FontAwesomeIcon icon={faMagnifyingGlass} className="settings-search-icon" />
          <input
            type="search"
            placeholder={t('settings.nav.search')}
            aria-label={t('settings.nav.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
          />
          {query && (
            <button type="button" className="settings-search-clear" aria-label={t('settings.nav.clearSearch')} onClick={() => setQuery('')}>
              <FontAwesomeIcon icon={faXmark} />
            </button>
          )}
        </div>
        {CATEGORIES.map((category) => {
          const items = visible.filter((s) => s.category === category.id);
          if (!items.length) return null;
          return (
            <div key={category.id} className="settings-nav-group">
              <div className="settings-nav-category">{t(category.titleKey)}</div>
              {items.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className="settings-nav-item"
                  onClick={() => open(section)}
                >
                  {section.icon && <FontAwesomeIcon icon={section.icon} className="settings-nav-icon" />}
                  {section.title}
                </button>
              ))}
            </div>
          );
        })}
        {!visible.length && <p className="settings-nav-empty">{t('settings.nav.noMatch', { query })}</p>}
      </nav>
  );

  return (
    <div className="settings-page">
      {navSlot ? createPortal(nav, navSlot) : nav}

      <div className="settings-content">
        {onProfilePage && <EditProfile />}
        {!onProfilePage && CATEGORIES.map((category) => {
          const inCategory = sections.filter((s) => s.category === category.id);
          return (
            <section key={category.id} className="settings-category" hidden={!inCategory.some(shown)} aria-label={t(category.titleKey)}>
              <h3 className="settings-category-title">{t(category.titleKey)}</h3>
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
