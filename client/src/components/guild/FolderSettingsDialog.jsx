import React, { useContext, useState } from 'react';
import Modal from './Modal';
import { LayoutContext } from '../../contexts';
import { COLOR_SWATCHES, colorToHex, hexToColor } from '../../utils/permissions';
import { t } from '../../i18n';

const MAX_NAME = 100;

// A guild folder's name and colour (as Discord's Folder Settings). No name: the rail shows its
// guilds' names; no colour: the theme's.
export default function FolderSettingsDialog({ folder, onClose }) {
  const { guildList } = useContext(LayoutContext);
  const [name, setName] = useState(folder.name ?? '');
  const [color, setColor] = useState(folder.color);

  function save(e) {
    e?.preventDefault();
    guildList.saveRail(guildList.rail.map((item) => (item.type === 'folder' && item.id === folder.id
      ? { ...item, name: name.trim() || null, color }
      : item)));
    onClose();
  }

  return (
    <Modal
      title={t('app.sidebar.folder.settings')}
      className="folder-settings"
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={save}>{t('common.save')}</button>
        </>
      )}
    >
      <form onSubmit={save} className="vc-form">
        <label htmlFor="folder-name">{t('app.sidebar.folder.name')}</label>
        <input
          id="folder-name"
          className="form-control"
          placeholder={folder.guilds.map((g) => g.name).join(', ')}
          maxLength={MAX_NAME}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <span className="vc-form-label" id="folder-colour-label">{t('app.sidebar.folder.colour')}</span>
        <div className="role-colors" role="radiogroup" aria-labelledby="folder-colour-label">
          <button
            type="button"
            role="radio"
            aria-checked={color == null}
            aria-label={t('app.sidebar.folder.defaultColour')}
            title={t('app.sidebar.folder.defaultColour')}
            className={`role-color default${color == null ? ' selected' : ''}`}
            onClick={() => setColor(null)}
          />
          {COLOR_SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              role="radio"
              aria-checked={color === swatch}
              aria-label={colorToHex(swatch)}
              className={`role-color${color === swatch ? ' selected' : ''}`}
              style={{ backgroundColor: colorToHex(swatch) }}
              onClick={() => setColor(swatch)}
            />
          ))}
          <label className={`role-color custom${color != null && !COLOR_SWATCHES.includes(color) ? ' selected' : ''}`} title={t('app.sidebar.folder.customColour')}>
            <input type="color" aria-label={t('app.sidebar.folder.customColour')} value={colorToHex(color ?? 0x99aab5)} onChange={(e) => setColor(hexToColor(e.target.value))} />
          </label>
        </div>
      </form>
    </Modal>
  );
}
