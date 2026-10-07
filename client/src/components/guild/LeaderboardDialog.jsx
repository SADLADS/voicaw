import React, { useCallback, useEffect, useState } from 'react';
import Modal from './Modal';
import Avatar from '../Avatar';
import { fetchLeaderboard } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { compactNumber, levelName, levelProgress, showsXp, xpName } from '../../utils/levels';
import { displayName, mergeProfiles, useProfiles } from '../../utils/profiles';
import { t } from '../../i18n';

const PAGE = 50;

// The guild's leaderboard (levels on): its members by XP, most first, with their rank, level
// and (unless the guild counts levels only) XP. Opened from the guild's menus.
export default function LeaderboardDialog({ guild, user, onClose }) {
  useProfiles();
  const settings = guild.levels;
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (offset) => {
    try {
      const page = await fetchLeaderboard(guild.id, { limit: PAGE, offset });
      mergeProfiles(page.map((row) => ({ ...row, id: row.user_id })));
      setRows((prev) => (offset ? [...(prev ?? []), ...page] : page));
      setMore(page.length === PAGE);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [guild.id]);

  useEffect(() => { load(0); }, [load]);

  return (
    <Modal title={t('levels.leaderboard.title')} onClose={onClose} className="leaderboard-dialog">
      {error && <p className="error-msg" role="alert">{error}</p>}
      {rows == null && !error && <p className="vc-hint">{t('common.loading')}</p>}
      {rows?.length === 0 && <p className="vc-hint">{t('levels.leaderboard.empty')}</p>}
      {rows?.length > 0 && (
        <ol className="leaderboard">
          {rows.map((row) => {
            const { level } = levelProgress(row.xp, settings);
            return (
              <li key={row.user_id} className={`leaderboard-row${row.user_id === user?.id ? ' mine' : ''}`}>
                <span className="leaderboard-rank">{row.rank}</span>
                <Avatar userId={row.user_id} />
                <span className="leaderboard-name">{displayName(row.user_id)}</span>
                {showsXp(settings) && <span className="leaderboard-xp">{compactNumber(row.xp)} {xpName(settings)}</span>}
                <span className="leaderboard-level">{levelName(settings)} {compactNumber(level)}</span>
              </li>
            );
          })}
        </ol>
      )}
      {more && (
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => load(rows.length)}>
          {t('levels.leaderboard.loadMore')}
        </button>
      )}
    </Modal>
  );
}
