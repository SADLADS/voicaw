import React from 'react';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCode } from '@fortawesome/free-solid-svg-icons';
import { DOCS_URL } from '../services/developerService';
import { t } from '../i18n';

// Settings card: the way to the developer portal (/developers, a page of its own) for making bots.
export default function DeveloperSettings() {
  const navigate = useNavigate();
  return (
    <div className="settings-card">
      <h5>
        <FontAwesomeIcon icon={faCode} className="settings-card-icon" />
        {t('settings.developers.title')}
      </h5>
      <p className="vc-hint">{t('settings.developers.description')}</p>
      <div className="vc-form-row">
        <button type="button" className="btn btn-primary vc-button" onClick={() => navigate('/developers')}>
          {t('settings.developers.open')}
        </button>
        <a className="btn btn-secondary" href={DOCS_URL} target="_blank" rel="noreferrer">{t('settings.developers.docs')}</a>
      </div>
    </div>
  );
}
