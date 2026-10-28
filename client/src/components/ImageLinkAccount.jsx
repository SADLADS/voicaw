import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Modal from './guild/Modal';
import { imageLinkIn, withoutImageLink } from '../utils/imageLink';
import { displayName, nameOf, useProfiles } from '../utils/profiles';
import { t } from '../i18n';

// A link to a picture (utils/imageLink.js, the desktop app's Open Image) from another account
// than the one logged in here: says so, and offers to log out, keeping the link, so logging in
// as that account opens the picture. Cancel drops the link and stays.
export default function ImageLinkAccount({ user, onLogout }) {
  const location = useLocation();
  const navigate = useNavigate();
  useProfiles(); // the other account's name, once the profiles have loaded
  const link = imageLinkIn(location.search);
  if (!link || link.as === String(user.id)) return null;
  const cancel = () => navigate({ pathname: location.pathname, search: withoutImageLink(location.search) }, { replace: true });
  return (
    <Modal
      title={t('app.imageLink.title')}
      onClose={cancel}
      actions={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={cancel}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onLogout} autoFocus>{t('app.imageLink.logOut')}</button>
        </>
      )}
    >
      <p>{t('app.imageLink.text', { name: displayName(link.as, t('app.imageLink.unknown')), current: nameOf(user) })}</p>
    </Modal>
  );
}
