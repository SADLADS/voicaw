import React, { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { faFlag } from '@fortawesome/free-solid-svg-icons';
import api from '../utils/api';
import EmojiPicker from './EmojiPicker';
import { ReactionEmoji } from './MessageReactions';
import { reactionPickerPosition } from '../utils/reactionPickerPosition';
import { t } from '../i18n';

const errorText = (err, fallback) => err.response?.data?.error || fallback;

const EMPTY = { name: '', flag: '', url: '', apiUrl: '', apiKey: '', apiSecret: '' };

// A region's flag, drawn as Twemoji (Windows has no flag emoji in its font).
function RegionFlag({ flag }) {
  if (!flag) return null;
  return <span className="voice-region-flag" aria-hidden="true"><ReactionEmoji native={flag} /></span>;
}

const PICKER_WIDTH = 360;

// The flag: any flag emoji (countries, 🏳️‍🌈, 🏴‍☠️, 🏁...), from the emoji picker's Flags.
function FlagField({ value, onChange }) {
  // The picker's place (the button's rect), while it's open.
  const [picking, setPicking] = useState(null);
  const close = useCallback(() => setPicking(null), []);
  // Opening to the right of the button's left edge (the picker lines up with a right edge; the
  // button is at the form's left, so the picker would cover it).
  const picker = picking && reactionPickerPosition({ ...picking, right: picking.left + PICKER_WIDTH });
  return (
    <div className="voice-region-field">
      <span>{t('settings.admin.voiceRegions.flag')}</span>
      <div className="voice-region-flag-choice">
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          aria-expanded={Boolean(picking)}
          aria-label={value ? t('settings.admin.voiceRegions.changeFlag') : t('settings.admin.voiceRegions.chooseFlag')}
          // Don't let the open picker's outside-click handler close it before this toggles.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            if (picking) return setPicking(null);
            const { top, bottom, left, right } = e.currentTarget.getBoundingClientRect();
            setPicking({ top, bottom, left, right });
          }}
        >
          {value ? <RegionFlag flag={value} /> : <Icon icon={faFlag} />}
        </button>
        {value && (
          <button type="button" className="btn btn-sm btn-link voice-region-flag-remove" onClick={() => onChange('')}>
            {t('common.remove')}
          </button>
        )}
      </div>
      {picker && createPortal(
        <div className={`reaction-picker-anchor${picker.below ? ' below' : ''}`} style={picker.style}>
          <EmojiPicker category="flags" onSelect={onChange} onClose={close} />
        </div>,
        document.body
      )}
    </div>
  );
}

// Adding or editing a region. The main one (`builtin`) only has a name and a flag here: its
// server is server/.env's. A secret is never shown; left empty when editing, it's kept.
function RegionForm({ region, onSaved, onCancel }) {
  const editing = Boolean(region);
  const [fields, setFields] = useState(editing
    ? { name: region.name, flag: region.flag, url: region.url ?? '', apiUrl: region.api_url ?? '', apiKey: region.api_key ?? '', apiSecret: '' }
    : EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (e) => setFields((f) => ({ ...f, [key]: e.target.value }));
  const id = (key) => `region-${region?.id ?? 'new'}-${key}`;

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = region?.builtin ? { name: fields.name, flag: fields.flag } : fields;
    try {
      const { data } = editing
        ? await api.patch(`/admin/voice-regions/${region.id}`, body)
        : await api.post('/admin/voice-regions', body);
      onSaved(data);
    } catch (err) {
      setError(errorText(err, t('settings.admin.couldntSave')));
      setSaving(false);
    }
  };

  const field = (key, label, props = {}) => (
    <label className="voice-region-field" htmlFor={id(key)}>
      <span>{label}</span>
      <input id={id(key)} type="text" autoComplete="off" spellCheck={false} value={fields[key]} onChange={set(key)} {...props} />
    </label>
  );

  return (
    <form className="voice-region-form" onSubmit={save}>
      <div className="voice-region-name-row">
        <FlagField value={fields.flag} onChange={(flag) => setFields((f) => ({ ...f, flag }))} />
        {field('name', t('settings.admin.voiceRegions.name'), { placeholder: t('settings.admin.voiceRegions.namePlaceholder'), maxLength: 50 })}
      </div>
      {region?.builtin ? (
        <p className="admin-setting-help">{t('settings.admin.voiceRegions.builtinHelp')}</p>
      ) : (
        <>
          {field('url', t('settings.admin.voiceRegions.url'), { placeholder: 'wss://rtc.example.com' })}
          {field('apiUrl', t('settings.admin.voiceRegions.apiUrl'), { placeholder: t('settings.admin.voiceRegions.apiUrlPlaceholder') })}
          {field('apiKey', t('settings.admin.voiceRegions.apiKey'))}
          {field('apiSecret', t('settings.admin.voiceRegions.apiSecret'), {
            type: 'password',
            autoComplete: 'new-password',
            placeholder: editing ? t('settings.admin.voiceRegions.keepSecret', { hint: region.secret_hint ?? '' }) : '',
          })}
        </>
      )}
      <div className="admin-setting-row">
        <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-sm uploadbutton" disabled={saving || !fields.name.trim()}>
          {editing ? t('common.save') : t('settings.admin.voiceRegions.add')}
        </button>
      </div>
      {error && <p className="error-msg">{error}</p>}
    </form>
  );
}

// Settings → Admin → Voice regions (server/voiceRegions.js): the LiveKit servers voice can go
// through, each with a flag and a name. The default takes calls and voice channels left on
// Automatic; guilds can put a voice channel in any of them.
export default function VoiceRegionsAdmin({ regions, onChange }) {
  const [editing, setEditing] = useState(null); // a region's id, 'new', or null
  const [confirming, setConfirming] = useState(null);
  const [error, setError] = useState(null);

  const saved = (list) => {
    onChange(list);
    setEditing(null);
    setConfirming(null);
  };

  const run = async (action) => {
    setError(null);
    try {
      saved((await action()).data);
    } catch (err) {
      setError(errorText(err, t('settings.admin.couldntSave')));
    }
  };

  return (
    <div className="admin-setting voice-regions-admin">
      <span className="admin-setting-label">{t('settings.admin.voiceRegions.title')}</span>
      <p className="admin-setting-help">{t('settings.admin.voiceRegions.help')}</p>
      <ul className="admin-list voice-region-list">
        {regions.map((region) => (
          <li key={region.id} className="voice-region">
            {editing === region.id ? (
              <RegionForm region={region} onSaved={saved} onCancel={() => setEditing(null)} />
            ) : (
              <>
                <span className="voice-region-summary">
                  <span className="voice-region-title">
                    <RegionFlag flag={region.flag} />
                    {region.name}
                    {region.default && <span className="voice-region-badge">{t('settings.admin.voiceRegions.default')}</span>}
                  </span>
                  <span className="admin-list-detail">
                    {region.available ? region.url : t('settings.admin.voiceRegions.notSetUp')}
                    {region.builtin && ` · ${t('settings.admin.voiceRegions.fromEnv')}`}
                    {region.secret_hint && ` · ${t('settings.admin.voiceRegions.keyAndSecret', { key: region.api_key, hint: region.secret_hint })}`}
                  </span>
                </span>
                <span className="admin-list-actions">
                  {confirming === region.id ? (
                    <>
                      <span className="admin-list-detail">{t('settings.admin.voiceRegions.confirmRemove')}</span>
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => setConfirming(null)}>{t('common.cancel')}</button>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => run(() => api.delete(`/admin/voice-regions/${region.id}`))}>
                        {t('common.remove')}
                      </button>
                    </>
                  ) : (
                    <>
                      {!region.default && region.available && (
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => run(() => api.patch(`/admin/voice-regions/${region.id}`, { default: true }))}>
                          {t('settings.admin.voiceRegions.makeDefault')}
                        </button>
                      )}
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditing(region.id)}>{t('common.edit')}</button>
                      {!region.builtin && (
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setConfirming(region.id)}>{t('common.remove')}</button>
                      )}
                    </>
                  )}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      {editing === 'new' ? (
        <RegionForm onSaved={saved} onCancel={() => setEditing(null)} />
      ) : (
        <button type="button" className="btn btn-sm uploadbutton" onClick={() => setEditing('new')}>{t('settings.admin.voiceRegions.addRegion')}</button>
      )}
      {error && <p className="error-msg">{error}</p>}
    </div>
  );
}
