import React, { useContext, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon } from './Icon';
import { faLockOpen, faTrash } from '@fortawesome/free-solid-svg-icons';
import '../assets/css/dms.css';
import { LayoutContext } from '../contexts';
import PaneBackButton from './PaneBackButton';
import ChatPane from './ChatPane';
import ConfirmDialog from './guild/ConfirmDialog';
import { useBotDm } from '../hooks/useBotDm';
import { deleteBotDm } from '../services/botDmService';
import { unblockUser, useBlocked } from '../utils/blocks';
import { displayName, nameOf, useProfiles } from '../utils/profiles';
import { t } from '../i18n';

const noReactions = async () => {};

// A conversation with a bot (/dm/b/:dmId; server/botDms.js). Not end-to-end encrypted: the
// header says so, and a line above the messages says who can read them. Text only (no files,
// polls, replies, reactions or pins). The header's bin deletes the whole conversation.
export default function BotDm({ user }) {
  const { dmId: param } = useParams();
  const dmId = Number(param);
  const navigate = useNavigate();
  const { botDmList } = useContext(LayoutContext);
  const summary = botDmList?.botDms.find((d) => d.id === dmId);
  const botId = summary?.bot_id;
  const conversation = useBotDm({ dmId, user, onRead: () => botDmList?.clearUnread(dmId) });
  const profilesVersion = useProfiles();
  const blocked = useBlocked().has(Number(botId));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const name = botId != null ? displayName(botId, summary.bot?.display_name || summary.bot?.username) : '';
  const reactionNames = useMemo(
    () => ({ [user?.id]: nameOf(user), ...(botId != null ? { [botId]: name } : {}) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.id, botId, name, profilesVersion]
  );

  return (
    <div id="dm-main" className="bot-dm" data-current-user-id={user?.id}>
      <h4 className="chat-recipient-header">
        <PaneBackButton />
        <span className="bot-dm-title">
          {name}
          {botId != null && <span className="app-tag" title={t('chat.message.botTitle')}>{t('chat.message.botTag')}</span>}
        </span>
        <span className="bot-dm-plain" title={t('chat.botDm.notEncryptedHint')}>
          <Icon icon={faLockOpen} /> {t('chat.botDm.notEncrypted')}
        </span>
        {summary && (
          <button
            type="button"
            className="chat-call-button"
            aria-label={t('chat.botDm.delete')}
            title={t('chat.botDm.delete')}
            onClick={() => setConfirmingDelete(true)}
          >
            <Icon icon={faTrash} />
          </button>
        )}
      </h4>

      {summary && (
        <p className="bot-dm-notice" role="note">{t('chat.botDm.notice', { name })}</p>
      )}

      <ChatPane
        chatId={`bot-dm-${dmId}`}
        chatName={summary ? name : null}
        user={user}
        conversation={conversation}
        encrypted={false}
        textOnly
        reactionsReady={false}
        saveReaction={noReactions}
        deleteReaction={noReactions}
        canAddReactions={false}
        canPin={false}
        reactionNames={reactionNames}
        canSend={Boolean(summary) && !blocked}
        cantSendText={summary ? t('chat.blocked.youBlocked', { name }) : t('common.loading')}
        emptyText={t('chat.botDm.empty', { name })}
      />
      {blocked && summary && (
        <div className="bot-dm-unblock">
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => unblockUser(botId).catch(() => {})}>
            {t('chat.blocked.unblock')}
          </button>
        </div>
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title={t('chat.botDm.deleteTitle', { name })}
          message={t('chat.botDm.deleteConfirm', { name })}
          confirmLabel={t('common.delete')}
          onConfirm={async () => {
            await deleteBotDm(dmId);
            navigate('/dm', { replace: true });
          }}
          onClose={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
