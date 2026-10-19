import React, { useState, useContext, useEffect, useRef } from "react";
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import { faCode, faMagnifyingGlass, faSignOutAlt, faXmark } from '@fortawesome/free-solid-svg-icons';
import { InteractionContext, LayoutContext } from '../contexts';
import NotificationSettings from "./NotificationSettings";
import ReactionNotificationSettings from "./ReactionNotificationSettings";
import AppUpdateSettings from "./AppUpdateSettings";
import { PasswordSettings, RecoveryCodeSettings } from "./AccountSecuritySettings";
import TwoFactorSettings from "./TwoFactorSettings";
import DeleteAccountSettings from "./DeleteAccountSettings";
import DeviceSettings from "./DeviceSettings";
import AdminSettings from "./AdminSettings";
import DateTimeSettings from "./DateTimeSettings";
import SpellcheckSettings from "./SpellcheckSettings";
import PrivacySettings from "./PrivacySettings";
import StorageSettings from "./StorageSettings";
import BlockedUsers from './BlockedUsers';
import AuthorisedApps from './AuthorisedApps';
import AdminReports from './AdminReports';
import ProfileVisibilitySettings from './ProfileVisibilitySettings';
import ContentSettings from "./ContentSettings";
import ThemeSettings from "./ThemeSettings";
import LanguageSettings from "./LanguageSettings";
import SoundSettings from "./SoundSettings";
import VoiceSettings from "./VoiceSettings";
import DesktopAppSettings from "./DesktopAppSettings";
import { isDesktopApp } from '../utils/desktop';
import AndroidAppSettings from './AndroidAppSettings';
import { isAndroidApp } from '../utils/android';
import { canShareScreen } from '../voice/voiceClient';
import Avatar from "./Avatar";
import PaneBackButton from './PaneBackButton';
import ConfirmDialog from './guild/ConfirmDialog';
import { useAuth } from '../hooks/useAuth';
import { useIsAdmin } from '../hooks/useIsAdmin';
import { useAdminAlerts } from '../hooks/useAdminAlerts';
import { showContent, showList } from '../utils/mobilePanes';
import { nameOf, useProfiles } from '../utils/profiles';
import { openUserProfile } from '../utils/userProfile';
import { Trans } from 'react-i18next';
import { t } from '../i18n';

const GROUPS = ['user', 'app', 'admin'];

// Whether a subsection matches the search: every word in its title, keywords or page's title.
function matches(page, sub, words) {
  const haystack = `${sub.title} ${sub.keywords} ${page.title}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// A subsection, as `t('settings.sections.<key>.title' / '.keywords')`.
function sub(id, key, extra) {
  return { id, title: t(`settings.sections.${key}.title`), keywords: t(`settings.sections.${key}.keywords`), ...extra };
}

// Settings (/settings/<page>#<subsection>): a page per category (My Account, Voice & Video...),
// listed in a column that also searches every page's subsections. The open page's
// subsections show under it in the column (on a computer; phones list only the pages) and
// scroll to their part of the page. A subsection with `content` is drawn in its own block
// (id `settings-<id>`); one without is a part of its page's `content` carrying that id itself
// (VoiceSettings' headings, AdminSettings' parts). `/settings#<id>`, the old one-page
// Settings' links, goes to the page holding that subsection (by id or `aliases`) or page.
//
// The column goes into Layout's `settingsNavSlot` with a portal: on a computer beside the rail,
// above the user panel; on a phone it's the list pane under the page, swiped between like the
// channel list and a chat (useSwipePanes). /settings alone is My Account; a phone opens it on
// the list, with My Account behind it (swiping left shows it). The card with your picture, name
// and "Edit Profile" at the top of the column opens your full profile (UserProfile), where your profile is edited; /settings/profile (the
// old Edit Profile page's address) opens it too, over /settings. Developer Portal and Log Out
// are buttons at the end of the column, with no page of their own.
export default function Settings({ onLogout }) {
  useProfiles();
  const { user } = useAuth() ?? {};
  const [query, setQuery] = useState('');
  const [confirmLogout, setConfirmLogout] = useState(false);
  const isAdmin = useIsAdmin();
  const alerts = useAdminAlerts();
  const location = useLocation();
  const navigate = useNavigate();
  const navSlot = useContext(LayoutContext)?.settingsNavSlot ?? null;
  const { isMobile } = useContext(InteractionContext);
  const contentRef = useRef(null);

  const pages = [
    {
      id: 'account', group: 'user', title: t('settings.pages.account'),
      subs: [
        sub('password', 'password', { aliases: ['account-security', 'log-out'], content: <PasswordSettings /> }),
        sub('recovery-code', 'recoveryCode', { content: <RecoveryCodeSettings /> }),
        sub('two-factor', 'twoFactor', { aliases: ['2fa'], content: <TwoFactorSettings /> }),
        sub('devices', 'devices', { content: <DeviceSettings /> }),
        sub('delete-account', 'deleteAccount', { content: <DeleteAccountSettings onDeleted={onLogout} /> }),
      ],
    },
    {
      id: 'privacy', group: 'user', title: t('settings.pages.privacy'),
      subs: [
        sub('privacy', 'privacy', { content: <PrivacySettings /> }),
        sub('storage', 'storage', { content: <StorageSettings /> }),
        sub('profile-visibility', 'profileVisibility', { content: <ProfileVisibilitySettings /> }),
        sub('content', 'content', { content: <ContentSettings /> }),
        sub('blocked', 'blocked', { content: <BlockedUsers /> }),
        sub('authorised-apps', 'authorisedApps', { content: <AuthorisedApps /> }),
      ],
    },
    {
      id: 'notifications', group: 'user', title: t('settings.pages.notifications'),
      subs: [
        sub('notifications', 'notifications', { content: <NotificationSettings /> }),
        sub('reactions', 'reactionNotifications', { content: <ReactionNotificationSettings /> }),
        sub('sounds', 'sounds', { content: <SoundSettings /> }),
      ],
    },
    {
      id: 'appearance', group: 'app', title: t('settings.pages.appearance'),
      subs: [sub('theme', 'theme', { content: <ThemeSettings /> })],
    },
    {
      id: 'language', group: 'app', title: t('settings.pages.language'),
      subs: [
        sub('language', 'language', { content: <LanguageSettings /> }),
        sub('date-time', 'dateTime', { content: <DateTimeSettings /> }),
        // Phones check spelling in their own keyboard.
        sub('spellcheck', 'spellcheck', { available: !isMobile, content: <SpellcheckSettings /> }),
      ],
    },
    {
      id: 'voice-video', group: 'app', title: t('settings.pages.voiceVideo'),
      content: <VoiceSettings />,
      subs: [
        sub('voice', 'voice'),
        sub('mic-test', 'micTest'),
        sub('noise-suppression', 'noiseSuppression'),
        sub('input-sensitivity', 'inputSensitivity'),
        sub('voice-processing', 'voiceProcessing'),
        sub('camera', 'camera'),
        sub('screen-share', 'screenShare', { available: canShareScreen() }),
      ],
    },
    {
      id: 'desktop-app', group: 'app', title: t('settings.pages.desktopApp'), available: isDesktopApp(),
      content: isDesktopApp() ? <DesktopAppSettings /> : null,
      subs: [sub('desktop-app', 'desktopApp'), sub('activity', 'activity'), sub('shortcuts', 'shortcuts')],
    },
    {
      id: 'android-app', group: 'app', title: t('settings.pages.androidApp'), available: isAndroidApp(),
      content: isAndroidApp() ? <AndroidAppSettings /> : null,
      subs: [
        sub('android-app', 'androidApp'),
        sub('lock-screen-calls', 'lockScreenCalls'),
        sub('notification-channels', 'notificationChannels'),
        sub('push-log', 'pushLog'),
      ],
    },
    {
      // Listed once the server says you're an admin; AdminSettings shows nothing to others.
      id: 'admin', group: 'admin', title: t('settings.pages.admin'), available: isAdmin,
      content: <AdminSettings />,
      // Sign-up and tester requests waiting (utils/adminAlerts), a count beside it until dealt with.
      alerts: alerts.signups + alerts.testers,
      subs: [
        sub('admin-general', 'adminGeneral'),
        sub('admin-signups', 'adminSignups', { alerts: alerts.signups + alerts.testers }),
        sub('admin-regions', 'adminRegions'),
        sub('admin-storage', 'adminStorage'),
        sub('admin-admins', 'adminAdmins'),
      ],
    },
    {
      // Reports and suspended accounts (AdminReports.jsx), for admins only like the one above.
      id: 'reports', group: 'admin', title: t('settings.pages.reports'), available: isAdmin,
      content: isAdmin ? <AdminReports /> : null,
      alerts: alerts.reports,
      subs: [sub('reports', 'reports', { alerts: alerts.reports }), sub('suspended', 'suspended')],
    },
    {
      id: 'about', title: t('settings.pages.about'),
      subs: [
        sub('version', 'appVersion', { aliases: ['app-version'], content: <AppUpdateSettings /> }),
        sub('credits', 'credits', {
          aliases: ['about'],
          content: (
            <div className="settings-card">
              <h5>{t('settings.sections.credits.title')}</h5>
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
            </div>
          ),
        }),
        sub('legal', 'legal', {
          content: (
            <div className="settings-card">
              <h5>{t('settings.sections.legal.title')}</h5>
              {/* On voicaw.com (website/src/legal); Google Play wants the privacy policy in the app too. */}
              <p className="settings-policy-links">
                <a href="https://voicaw.com/privacy/" target="_blank" rel="noreferrer">{t('settings.about.privacy')}</a>
                <a href="https://voicaw.com/terms/" target="_blank" rel="noreferrer">{t('settings.about.terms')}</a>
                <a href="https://voicaw.com/delete-account/" target="_blank" rel="noreferrer">{t('settings.about.deleteAccount')}</a>
              </p>
            </div>
          ),
        }),
      ],
    },
  ];
  const available = (item) => item.available !== false;
  const listed = pages.filter(available);

  // The page in the URL: /settings/<id>. /settings alone is My Account (behind the list, on a
  // phone).
  const segment = location.pathname.split('/')[2] ?? '';
  const page = pages.find((p) => p.id === segment) ?? pages[0];
  const hash = decodeURIComponent(location.hash.slice(1));

  // Going to a page (and subsection): on a phone it slides over the list, the move replacing
  // the list's history entry (useSwipePanes adds the page's own over it, so Back shows the list).
  function go(path, { replace = false } = {}) {
    if (isMobile) showContent();
    navigate(path, { replace: replace || isMobile });
  }

  // The old Edit Profile page: your full profile, over Settings.
  useEffect(() => {
    if (segment !== 'profile' || !user) return;
    openUserProfile(user.id);
    navigate('/settings', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment]);

  // The old one-page Settings' links (/settings#devices): the page with that subsection.
  useEffect(() => {
    if (segment || !hash) return;
    const holder = pages.find((p) => p.subs.some((s) => s.id === hash || s.aliases?.includes(hash)));
    const target = holder?.subs.find((s) => s.id === hash || s.aliases?.includes(hash));
    if (holder) go(`/settings/${holder.id}#${target.id}`, { replace: true });
    else if (pages.some((p) => p.id === hash)) go(`/settings/${hash}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment, hash]);

  // On a phone /settings alone is the list: slide to it if a page was showing (something
  // went to /settings from a page, before its entry is marked as the page's).
  useEffect(() => {
    if (isMobile && !segment && !hash) showList();
  }, [isMobile, segment, hash]);

  // A subsection in the URL scrolls to it (again each time it's picked, a new location key);
  // a page alone opens at its top.
  useEffect(() => {
    const target = hash && document.getElementById(`settings-${hash}`);
    if (target) target.scrollIntoView({ block: 'start' });
    else if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [segment, hash, location.key]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = words.length
    ? listed.flatMap((p) => p.subs.filter((s) => available(s) && matches(p, s, words)).map((s) => ({ page: p, sub: s })))
    : null;

  // Admins: how many are waiting on a page or subsection.
  const alertsBadge = (count) => (count > 0 ? (
    <span className="mention-badge settings-nav-alerts" title={t('settings.nav.waiting', { count })}>{count > 99 ? '99+' : count}</span>
  ) : null);

  const pageButton = (p) => {
    const active = page?.id === p.id;
    const subs = p.subs.filter(available);
    return (
      <React.Fragment key={p.id}>
        <button
          type="button"
          className={`settings-nav-item${active ? ' active' : ''}`}
          aria-current={active ? 'page' : undefined}
          onClick={() => go(`/settings/${p.id}`)}
        >
          {p.title}
          {alertsBadge(p.alerts)}
        </button>
        {/* The open page's subsections (a computer's, and not a lone one). */}
        {active && !isMobile && subs.length > 1 && (
          <div className="settings-nav-subs" role="group" aria-label={t('settings.nav.subsections', { page: p.title })}>
            {subs.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`settings-nav-sub${hash === s.id ? ' active' : ''}`}
                onClick={() => go(`/settings/${p.id}#${s.id}`)}
              >
                {s.title}
                {alertsBadge(s.alerts)}
              </button>
            ))}
          </div>
        )}
      </React.Fragment>
    );
  };

  const nav = (
      <nav className="settings-nav" aria-label={t('settings.nav.label')}>
        <h2 className="settings-header">{t('common.settings')}</h2>
        {user && (
          <button
            type="button"
            className="settings-profile-link"
            onClick={() => openUserProfile(user.id)}
          >
            <Avatar userId={user.id} className="settings-profile-avatar" />
            <span className="settings-profile-text">
              <span className="settings-profile-name">{nameOf(user)}</span>
              <span className="settings-profile-action">{t('settings.nav.editProfile')}</span>
            </span>
          </button>
        )}
        <div className="settings-search">
          <Icon icon={faMagnifyingGlass} className="settings-search-icon" />
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
              <Icon icon={faXmark} />
            </button>
          )}
        </div>
        {results ? (
          <div className="settings-nav-group">
            {results.map(({ page: p, sub: s }) => (
              <button
                key={`${p.id}-${s.id}`}
                type="button"
                className="settings-nav-item settings-nav-result"
                onClick={() => go(`/settings/${p.id}#${s.id}`)}
              >
                <span className="settings-nav-result-title">{s.title}</span>
                <span className="settings-nav-result-page">{p.title}</span>
              </button>
            ))}
            {!results.length && <p className="settings-nav-empty">{t('settings.nav.noMatch', { query })}</p>}
          </div>
        ) : (
          <>
            {GROUPS.map((group) => {
              const items = listed.filter((p) => p.group === group);
              if (!items.length) return null;
              return (
                <div key={group} className="settings-nav-group">
                  <div className="settings-nav-category">{t(`settings.groups.${group}`)}</div>
                  {items.map(pageButton)}
                </div>
              );
            })}
            <div className="settings-nav-group settings-nav-end">
              {listed.filter((p) => !p.group).map(pageButton)}
              <button type="button" className="settings-nav-item" onClick={() => navigate('/developers')}>
                <Icon icon={faCode} className="settings-nav-icon" />
                {t('settings.nav.developerPortal')}
              </button>
              <button type="button" className="settings-nav-item danger" onClick={() => setConfirmLogout(true)}>
                <Icon icon={faSignOutAlt} className="settings-nav-icon" />
                {t('settings.nav.logOut')}
              </button>
            </div>
          </>
        )}
      </nav>
  );

  const title = page?.title;
  return (
    <div className="settings-page">
      {navSlot ? createPortal(nav, navSlot) : nav}

      {title && (
        <div className="settings-main">
          <h4 className="chat-recipient-header settings-page-header">
            <PaneBackButton />
            <span className="settings-page-title">{title}</span>
          </h4>
          <div ref={contentRef} className="settings-content">
            {page.content}
            {page.subs.filter((s) => available(s) && s.content).map((s) => (
              <div key={s.id} id={`settings-${s.id}`} className="settings-section">
                {s.content}
              </div>
            ))}
          </div>
        </div>
      )}

      {confirmLogout && (
        <ConfirmDialog
          title={t('settings.logOut.confirmTitle')}
          message={t('settings.logOut.confirmMessage')}
          confirmLabel={t('settings.logOut.confirm')}
          focusConfirm
          onConfirm={() => onLogout?.()}
          onClose={() => setConfirmLogout(false)}
        />
      )}
    </div>
  );
}
