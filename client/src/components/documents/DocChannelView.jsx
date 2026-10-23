import React, { Suspense, lazy, useCallback, useContext, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '../Icon';
import { faChevronLeft, faComment, faFaceSmile, faPen, faPlus, faTrash } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/documents.css';
import ChatPane from '../ChatPane';
import EmojiPicker from '../EmojiPicker';
import MessageReactions from '../MessageReactions';
import { DocumentMarkdown } from '../MessageList';
import Avatar from '../Avatar';
import ConfirmDialog from '../guild/ConfirmDialog';
import DocumentCover from './DocumentCover';
import ImageMenu from '../ImageMenu';
import { useImageHold } from '../../hooks/useImageHold';
import { ConfigContext } from '../../contexts';
import { useChannel } from '../../hooks/useChannel';
import { toggleDocumentReaction, useDocument, useDocumentFeed } from '../../hooks/useDocuments';
import { deleteDocument } from '../../services/guildService';
import { documentExcerpt } from '../../documents/documentText';
import { PERMISSIONS, has } from '../../utils/permissions';
import { displayName, useProfiles } from '../../utils/profiles';
import { formatDate, formatDateTime, useDateFormat } from '../../utils/dateFormat';
import { reactionPickerPosition } from '../../utils/reactionPickerPosition';
import { getKeyboardHeight } from '../../utils/keyboardHeight';
import { errorMessage } from '../../utils/guildDisplay';
import { t } from '../../i18n';

// The editor (ProseMirror, tables, markdown) is only loaded once someone writes.
const DocumentEditor = lazy(() => import('./DocumentEditor'));

function Byline({ document, nameColors }) {
  useProfiles();
  useDateFormat();
  const author = displayName(document.created_by, t('documents.deletedUser'));
  const edited = document.updated_at > document.created_at + 60;
  return (
    <span className="document-byline">
      <Avatar userId={document.created_by} className="document-byline-avatar" />
      <span className="document-author" style={nameColors?.[document.created_by] ? { color: nameColors[document.created_by] } : undefined}>
        {author}
      </span>
      <span className="document-date" title={formatDateTime(document.created_at * 1000)}>{formatDate(document.created_at * 1000)}</span>
      {edited && (
        <span className="document-date" title={formatDateTime(document.updated_at * 1000)}>
          {document.updated_by !== document.created_by
            ? t('documents.byline.editedBy', { date: formatDate(document.updated_at * 1000), name: displayName(document.updated_by, t('documents.deletedUser')) })
            : t('documents.byline.edited', { date: formatDate(document.updated_at * 1000) })}
        </span>
      )}
    </span>
  );
}

// A document in the feed: its cover (if any), title, who wrote it, how it starts, reactions
// (which can be toggled and added from here) and replies. The rest of the card opens it.
function DocumentCard({ document, user, reactionNames, canReact, isMobile, nameColors, onOpen, onToggle }) {
  const excerpt = useMemo(() => documentExcerpt(document.content_start), [document.content_start]);
  const [reactError, setReactError] = useState(null);
  const toggle = (emoji) => onToggle(document, emoji)
    .then(() => setReactError(null))
    .catch((err) => setReactError(errorMessage(err)));
  return (
    <article className={`document-card${document.cover ? ' has-cover' : ''}`}>
      <button type="button" className="document-card-open" aria-label={t('documents.card.open', { title: document.title })} onClick={onOpen} />
      <DocumentCover cover={document.cover} className="document-card-cover" />
      <div className="document-card-body">
        <h3 className="document-card-title">{document.title}</h3>
        <Byline document={document} nameColors={nameColors} />
        {excerpt && <p className="document-card-excerpt">{excerpt}</p>}
        {(document.reactions.length > 0 || document.reply_count > 0 || canReact) && (
          <div className="document-card-footer">
            <DocumentReactions
              compact
              document={document}
              user={user}
              reactionNames={reactionNames}
              canReact={canReact}
              isMobile={isMobile}
              onToggle={toggle}
            />
            {document.reply_count > 0 && (
              <span className="document-card-replies">
                <Icon icon={faComment} /> {t('documents.card.replies', { count: document.reply_count })}
              </span>
            )}
          </div>
        )}
        {reactError && <p className="error-msg document-card-error" role="alert">{reactError}</p>}
      </div>
    </article>
  );
}

function DocumentFeed({ channel, feed, user, reactionNames, isMobile, canCreate, nameColors, onOpen, onNew }) {
  const { documents, loaded, error, apply } = feed;
  const canReact = has(channel.my_permissions, PERMISSIONS.ADD_REACTIONS);
  const toggle = (document, emoji) => toggleDocumentReaction(document, user.id, emoji, apply);
  return (
    <div className="document-feed">
      <div className="document-feed-inner">
        <div className="document-feed-header">
          <div>
            <h2 className="document-feed-title">{channel.name}</h2>
            {channel.topic && <p className="vc-hint">{channel.topic}</p>}
          </div>
          {canCreate && (
            <button type="button" className="btn btn-primary btn-sm vc-button" onClick={onNew}>
              <Icon icon={faPlus} /> {t('documents.feed.newDocument')}
            </button>
          )}
        </div>
        {error && <p className="error-msg" role="alert">{error}</p>}
        {loaded && !error && documents.length === 0 && (
          <p className="guild-placeholder document-empty">
            {canCreate ? t('documents.feed.emptyCanCreate') : t('documents.feed.empty')}
          </p>
        )}
        <div className="document-cards">
          {documents.map((d) => (
            <DocumentCard
              key={d.id}
              document={d}
              user={user}
              reactionNames={reactionNames}
              canReact={canReact}
              isMobile={isMobile}
              nameColors={nameColors}
              onOpen={() => onOpen(d.id)}
              onToggle={toggle}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// Reactions under a document: its chips, and a button for the picker (floating on a
// computer, docked in the keyboard's place on a phone). `compact` (a feed card): no rule
// above, and the button is just the smiley.
function DocumentReactions({ document, user, reactionNames, canReact, isMobile, onToggle, compact = false }) {
  const [pickerRect, setPickerRect] = useState(null);
  const open = (anchor) => setPickerRect(anchor.getBoundingClientRect());
  const close = () => setPickerRect(null);
  const pick = (emoji) => {
    close();
    onToggle(emoji);
  };
  const hasAny = document.reactions.length > 0;
  return (
    <div className={`document-reactions${compact ? ' compact' : ''}`}>
      <MessageReactions
        reactions={document.reactions}
        userId={user.id}
        names={reactionNames}
        onToggle={onToggle}
        onAdd={canReact ? open : undefined}
      />
      {!hasAny && canReact && (
        <button
          type="button"
          className="reaction-chip reaction-add document-react"
          aria-label={compact ? t('documents.reactions.add') : undefined}
          title={compact ? t('documents.reactions.add') : undefined}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => open(e.currentTarget)}
        >
          <Icon icon={faFaceSmile} />{!compact && ` ${t('documents.reactions.react')}`}
        </button>
      )}
      {pickerRect && !isMobile && (() => {
        const { below, style } = reactionPickerPosition(pickerRect);
        return (
          <div className={`reaction-picker-anchor${below ? ' below' : ''}`} style={style}>
            <EmojiPicker onSelect={pick} onClose={close} />
          </div>
        );
      })()}
      {pickerRect && isMobile && <div className="document-docked-picker"><EmojiPicker docked height={getKeyboardHeight()} onSelect={pick} onClose={close} /></div>}
    </div>
  );
}

// One document: the page itself (cover, title, byline, text, reactions) and its replies, an
// ordinary chat beside it (on a phone, a tab).
function DocumentPage({ guild, channel, user, documentId, editing, setEditing, onBack, chatProps, isMobile, nameColors }) {
  const { s3Endpoint } = useContext(ConfigContext);
  const { document, missing, apply, replace } = useDocument(documentId);
  const conversation = useChannel({ channelId: missing ? null : channel.id, documentId, user, onRead: chatProps.onRead });
  const [tab, setTab] = useState('document');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reactError, setReactError] = useState(null);
  const permissions = channel.my_permissions ?? 0;

  if (missing) {
    return (
      <div className="document-missing">
        <p className="guild-placeholder">{t('documents.page.missing')}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>{t('documents.page.backToAll')}</button>
      </div>
    );
  }
  if (!document) return <div className="document-page" aria-busy="true" />;

  // As the server's (routes/guildDocuments.js): its author with Create Documents, or Manage
  // Messages, manage it; anyone with Create Documents edits it once it's open to editing.
  const mine = document.created_by === user.id;
  const canManage = has(permissions, PERMISSIONS.MANAGE_MESSAGES) || (mine && has(permissions, PERMISSIONS.CREATE_DOCUMENTS));
  const canEdit = canManage || (Boolean(document.open_editing) && has(permissions, PERMISSIONS.CREATE_DOCUMENTS));

  if (editing && canEdit) {
    return (
      <Suspense fallback={<div className="document-page" aria-busy="true" />}>
        <DocumentEditor
          channel={channel}
          document={document}
          userId={user.id}
          canManage={canManage}
          onDone={(latest) => { replace(latest); setEditing(false); }}
        />
      </Suspense>
    );
  }

  const toggle = (emoji) => toggleDocumentReaction(document, user.id, emoji, apply)
    .then(() => setReactError(null))
    .catch((err) => setReactError(errorMessage(err)));

  const page = (
    <div className="document-scroll">
      <article className="document-page-inner">
        <DocumentCover cover={document.cover} className="document-page-cover" />
        <h1 className="document-title">{document.title}</h1>
        <Byline document={document} nameColors={nameColors} />
        <DocumentMarkdown
          text={document.content}
          user={user}
          s3Endpoint={s3Endpoint}
          reactionNames={chatProps.reactionNames}
          mentionRoles={chatProps.mentionRoles}
          myRoleIds={guild.my_role_ids}
        />
        <DocumentReactions
          document={document}
          user={user}
          reactionNames={chatProps.reactionNames}
          canReact={has(permissions, PERMISSIONS.ADD_REACTIONS)}
          isMobile={isMobile}
          onToggle={toggle}
        />
        {reactError && <p className="error-msg" role="alert">{reactError}</p>}
      </article>
    </div>
  );

  const replies = (
    <section className="document-replies" aria-label={t('documents.page.replies')}>
      {!isMobile && <h2 className="document-replies-title">{t('documents.page.replies')}</h2>}
      <div className="document-replies-chat">
        <ChatPane
          {...chatProps}
          chatId={`document-${document.id}`}
          chatName={document.title}
          chatTexts={{
            label: t('documents.page.repliesLabel', { title: document.title }),
            placeholder: t('documents.page.repliesPlaceholder', { title: document.title }),
            upload: t('documents.page.repliesUpload', { title: document.title }),
          }}
          conversation={conversation}
          canPin={false}
          emptyText={t('documents.page.noReplies')}
          focusOnOpen={false}
        />
      </div>
    </section>
  );

  return (
    <div className="document-page">
      <header className="document-page-header">
        <button type="button" className="document-back" onClick={onBack} aria-label={t('documents.page.allDocuments')} title={t('documents.page.allDocuments')}>
          <Icon icon={faChevronLeft} />{!isMobile && ` ${t('documents.page.allDocuments')}`}
        </button>
        {isMobile && (
          <div className="document-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'document'} className={tab === 'document' ? 'active' : ''} onClick={() => setTab('document')}>
              {t('documents.page.documentTab')}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'replies'} className={tab === 'replies' ? 'active' : ''} onClick={() => setTab('replies')}>
              {conversation.messages.length
                ? t(conversation.hasMore ? 'documents.page.repliesTabCountMore' : 'documents.page.repliesTabCount', { number: conversation.messages.filter((m) => !m.system).length })
                : t('documents.page.replies')}
            </button>
          </div>
        )}
        <span className="document-page-actions">
          {canEdit && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
              <Icon icon={faPen} />{!isMobile && ` ${t('common.edit')}`}
            </button>
          )}
          {canManage && (
            <button type="button" className="btn btn-outline-danger btn-sm" aria-label={t('documents.page.deleteDocument')} title={t('documents.page.deleteDocument')} onClick={() => setConfirmDelete(true)}>
              <Icon icon={faTrash} />
            </button>
          )}
        </span>
      </header>
      <div className="document-page-body">
        {(!isMobile || tab === 'document') && page}
        {(!isMobile || tab === 'replies') && replies}
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title={t('documents.page.deleteDocument')}
          message={t('documents.page.confirmDelete', { title: document.title })}
          confirmLabel={t('common.delete')}
          onConfirm={async () => {
            await deleteDocument(document.id);
            onBack();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

// A document channel (Guilded's docs): a feed of documents, newest first, each opening to a
// page with reactions and a thread of replies. `?doc=<id>` opens one (links and notifications
// use it), `?doc=new` writes a new one, `&edit=1` edits. Who may write, edit and reply follows
// the channel's permissions (Create Documents, Manage Messages, Send Messages).
// `chatProps` are ChatPane's guild-wide props (names, mentions, permissions, colours).
export default function DocChannelView(props) {
  // Holding a picture (a cover, one in a document or the editor) opens its menu on a phone.
  const { holdProps, held, closeHeld } = useImageHold();
  return (
    <div className="doc-channel" {...holdProps}>
      <DocChannelContent {...props} />
      {held && <ImageMenu item={held} sheet onClose={closeHeld} />}
    </div>
  );
}

function DocChannelContent({ guild, channel, user, isMobile, nameColors, chatProps }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const docParam = searchParams.get('doc');
  const writingNew = docParam === 'new';
  const documentId = writingNew ? null : Number(docParam) || null;
  const editing = searchParams.get('edit') === '1';
  const canCreate = has(channel.my_permissions, PERMISSIONS.CREATE_DOCUMENTS);

  const go = useCallback((doc, { edit = false, replace = false } = {}) => {
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      if (doc) next.set('doc', String(doc));
      else next.delete('doc');
      if (edit) next.set('edit', '1');
      else next.delete('edit');
      return next;
    }, { replace });
  }, [setSearchParams]);

  const feed = useDocumentFeed({ channelId: channel.id, showing: !docParam, onRead: chatProps.onRead });

  if (writingNew) {
    if (!canCreate) return <p className="guild-placeholder">{t('documents.feed.noPermission')}</p>;
    return (
      <Suspense fallback={<div className="document-page" aria-busy="true" />}>
        <DocumentEditor
          channel={channel}
          document={null}
          userId={user.id}
          canManage
          onSaved={(saved) => {
            feed.apply({ type: 'guild_document_upsert', document: { ...saved, content_start: saved.content.slice(0, 1000) } });
            go(saved.id, { replace: true });
          }}
          onCancel={() => go(null, { replace: true })}
        />
      </Suspense>
    );
  }
  if (documentId) {
    return (
      <DocumentPage
        key={documentId}
        guild={guild}
        channel={channel}
        user={user}
        documentId={documentId}
        editing={editing}
        setEditing={(on) => go(documentId, { edit: on, replace: true })}
        onBack={() => go(null)}
        chatProps={chatProps}
        isMobile={isMobile}
        nameColors={nameColors}
      />
    );
  }
  return (
    <DocumentFeed
      channel={channel}
      feed={feed}
      user={user}
      reactionNames={chatProps.reactionNames}
      isMobile={isMobile}
      canCreate={canCreate}
      nameColors={nameColors}
      onOpen={(id) => go(id)}
      onNew={() => go('new')}
    />
  );
}

