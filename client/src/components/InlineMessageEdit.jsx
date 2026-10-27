import React from 'react';
import { Trans } from 'react-i18next';
import MessageEditor from '../editor/MessageEditor';
import EditorSuggestions from './EditorSuggestions';
import { useEditorSuggestions } from '../hooks/useEditorSuggestions';
import { t } from '../i18n';

// A message being edited in place (MessageList), with the message box's ":smi", "@na" and
// "#gen" suggestions (`suggestFrom`: useEditorSuggestions' people, roles, roleInfo,
// canMentionEveryone and channels) above it (in the row, not floating: the list scrolls, so the top message's would
// be cut off). `editRef` is its MessageEditor's handle.
export default function InlineMessageEdit({
  messageId,
  editRef,
  initialText,
  mentionNames,
  mentionRoles,
  maxLength,
  submitOnEnter,
  s3Endpoint,
  suggestFrom,
  onChange,
  onSave,
  onCancel,
}) {
  const suggest = useEditorSuggestions(editRef, { s3Endpoint, ...suggestFrom });
  return (
    <div className="inline-edit-wrapper">
      <EditorSuggestions suggest={suggest} s3Endpoint={s3Endpoint} />
      <MessageEditor
        ref={editRef}
        id={`edit-input-${messageId}`}
        className="inline-edit-editor"
        ariaLabel={t('chat.message.editLabel')}
        initialText={initialText}
        mentionNames={mentionNames}
        mentionRoles={mentionRoles}
        maxLength={maxLength}
        submitOnEnter={submitOnEnter}
        onSubmit={onSave}
        onChange={(change) => {
          onChange(change.text);
          suggest.onChange(change);
        }}
        onKeyDown={(e) => {
          if (suggest.onKeyDown(e)) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        autoFocus
      />

      <div className="inline-edit-banner">
        <span>
          <Trans
            i18nKey="chat.message.editHint"
            components={{
              cancel: <a href="#" onClick={(e) => { e.preventDefault(); onCancel(); }} />,
              save: <a href="#" onClick={(e) => { e.preventDefault(); onSave(); }} />,
            }}
          />
        </span>
      </div>
    </div>
  );
}
