import React, { useCallback, useEffect, useState } from 'react';
import api from '../utils/api';
import { t } from '../i18n';
import { formatBytes } from '../utils/formatBytes';
import { formatDateTime } from '../utils/dateFormat';

// Below this share of the drive free, the figure turns to a warning.
const LOW_FREE = 0.1;

const BUCKET_LABELS = {
  uploads: 'settings.admin.storage.buckets.uploads',
  'profile-pics': 'settings.admin.storage.buckets.profilePics',
  'guild-icons': 'settings.admin.storage.buckets.guildIcons',
  emojis: 'settings.admin.storage.buckets.emojis',
};

function Row({ label, bytes, objects }) {
  return (
    <li>
      <span>{label}</span>
      <span className="admin-list-detail admin-storage-amount">
        {objects == null ? formatBytes(bytes) : t('settings.admin.storage.amount', { size: formatBytes(bytes), count: objects })}
      </span>
    </li>
  );
}

// Settings → Admin → Storage: how full the object store is (server/storageStats.js, from MinIO's
// metrics, wherever it runs). Voicaw's buckets, whatever else is on the drive, and what's free.
export default function StorageAdmin() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async (fresh) => {
    setLoading(true);
    setError(false);
    try {
      const { data } = await api.get(`/admin/storage${fresh ? '?fresh=1' : ''}`);
      setStats(data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  const known = stats?.available && stats.total != null && stats.free != null;
  const ours = stats?.buckets?.reduce((sum, b) => sum + b.bytes, 0) ?? 0;
  const otherBuckets = stats?.otherBuckets?.bytes ?? 0;
  // The rest of what's used: other projects' files, the system, anything put there by hand.
  const otherFiles = known ? Math.max(0, stats.total - stats.free - ours - otherBuckets) : 0;
  const share = (bytes) => `${known && stats.total ? (bytes / stats.total) * 100 : 0}%`;
  const low = known && stats.total > 0 && stats.free / stats.total < LOW_FREE;

  return (
    <div className="admin-setting admin-storage">
      <label>{t('settings.admin.storage.title')}</label>
      <p className="admin-setting-help">{t('settings.admin.storage.help')}</p>
      {stats && !stats.available && (
        <p className="admin-setting-state">{t('settings.admin.storage.unavailable')}</p>
      )}
      {known && (
        <>
          <p className={`admin-storage-free${low ? ' low' : ''}`}>
            {t('settings.admin.storage.free', {
              free: formatBytes(stats.free),
              total: formatBytes(stats.total),
              percent: Math.round((stats.free / stats.total) * 100),
            })}
          </p>
          <div
            className="admin-storage-bar"
            role="img"
            aria-label={t('settings.admin.storage.barLabel', {
              used: formatBytes(stats.total - stats.free),
              total: formatBytes(stats.total),
            })}
          >
            <span className="admin-storage-ours" style={{ width: share(ours) }} />
            <span className="admin-storage-other" style={{ width: share(otherBuckets + otherFiles) }} />
          </div>
          <p className="admin-storage-key">
            <span><span className="admin-storage-swatch admin-storage-ours" />{t('settings.admin.storage.voicaw', { size: formatBytes(ours) })}</span>
            <span><span className="admin-storage-swatch admin-storage-other" />{t('settings.admin.storage.other', { size: formatBytes(otherBuckets + otherFiles) })}</span>
            <span><span className="admin-storage-swatch" />{t('settings.admin.storage.freeKey', { size: formatBytes(stats.free) })}</span>
          </p>
        </>
      )}
      {stats?.available && (
        <ul className="admin-list">
          {stats.buckets.map((b) => (
            <Row key={b.name} label={BUCKET_LABELS[b.name] ? t(BUCKET_LABELS[b.name]) : b.name} bytes={b.bytes} objects={b.objects} />
          ))}
          {otherBuckets > 0 && (
            <Row label={t('settings.admin.storage.otherBuckets')} bytes={otherBuckets} objects={stats.otherBuckets.objects} />
          )}
          {known && <Row label={t('settings.admin.storage.otherFiles')} bytes={otherFiles} />}
        </ul>
      )}
      {stats?.available && <p className="admin-setting-help">{t('settings.admin.storage.lag')}</p>}
      <div className="admin-setting-row">
        {stats?.checkedAt && (
          <span className="admin-setting-state">
            {t('settings.admin.storage.checked', { date: formatDateTime(stats.checkedAt) })}
          </span>
        )}
        <button type="button" className="btn btn-sm btn-secondary" disabled={loading} onClick={() => load(true)}>
          {loading ? t('settings.admin.storage.checking') : t('settings.admin.storage.refresh')}
        </button>
      </div>
      {error && <p className="error-msg">{t('settings.admin.storage.couldntLoad')}</p>}
    </div>
  );
}
