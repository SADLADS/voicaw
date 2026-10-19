import React from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import { faArrowLeft, faBook, faCode } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/guilds.css';
import '../../assets/css/developers.css';
import { DOCS_URL } from '../../services/developerService';
import { t } from '../../i18n';
import { usePageTitle } from '../../hooks/usePageTitle';

// The developer pages' own frame (the portal and the authorise page are pages of their own,
// not inside the app's rail and sidebar): a header with the way back and the docs, then the page.
export default function DeveloperPage({ title = t('developers.title'), titleLink = '/developers', children }) {
  usePageTitle(title);
  return (
    <div className="dev-page">
      <header className="dev-header">
        <Link to={titleLink} className="dev-header-title">
          <Icon icon={faCode} className="dev-header-icon" />
          <span>{title}</span>
        </Link>
        <nav className="dev-header-links">
          <a href={DOCS_URL} target="_blank" rel="noreferrer" className="dev-header-link">
            <Icon icon={faBook} />
            <span>{t('developers.docs')}</span>
          </a>
          <Link to="/dm" className="dev-header-link">
            <Icon icon={faArrowLeft} />
            <span>{t('developers.back')}</span>
          </Link>
        </nav>
      </header>
      <main className="dev-main">{children}</main>
    </div>
  );
}
