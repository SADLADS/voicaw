import React, { useState } from 'react';
import Modal from './Modal';
import { createCategory, deleteCategory, renameCategory } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { t } from '../../i18n';

// Creating a category (no `category`) or renaming / deleting one. Deleting keeps its channels
// (they move out of it).
export default function CategoryDialog({ guild, category, onClose }) {
  const editing = Boolean(category);
  const [name, setName] = useState(category?.name ?? '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function save(e) {
    e.preventDefault();
    if (!name.trim()) return;
    run(() => (editing ? renameCategory(guild.id, category.id, name.trim()) : createCategory(guild.id, name.trim())));
  }

  return (
    <Modal
      title={editing ? t('guildAdmin.categoryDialog.editTitle') : t('guildAdmin.categoryDialog.createTitle')}
      onClose={onClose}
      actions={(
        <>
          {editing && (
            <button type="button" className="btn btn-outline-danger btn-sm me-auto" disabled={busy} onClick={() => run(() => deleteCategory(guild.id, category.id))}>
              {t('guildAdmin.categoryDialog.delete')}
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" form="category-form" className="btn btn-primary btn-sm vc-button" disabled={busy || !name.trim()}>
            {editing ? t('common.save') : t('guildAdmin.categoryDialog.createTitle')}
          </button>
        </>
      )}
    >
      <form id="category-form" className="vc-form" onSubmit={save}>
        <label htmlFor="category-name">{t('guildAdmin.categoryDialog.name')}</label>
        <input
          id="category-name"
          className="form-control"
          maxLength={100}
          placeholder={t('guildAdmin.categoryDialog.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        {editing && <p className="vc-hint">{t('guildAdmin.categoryDialog.deleteHint')}</p>}
      </form>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
