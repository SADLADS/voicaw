import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPuzzlePiece } from '@fortawesome/free-solid-svg-icons';
import { setPrivacyPref, usePrivacyPrefs } from '../utils/privacy';

// Settings → Privacy: choices that trade a little privacy for convenience, on this device
// (utils/privacy). Each defaults to the convenient option; turning it off is the private one.
export default function PrivacySettings() {
  const prefs = usePrivacyPrefs();
  return (
    <div className="settings-card">
      <h5><FontAwesomeIcon icon={faPuzzlePiece} className="settings-card-icon" />Privacy</h5>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.inviteEmbedsInEncrypted}
          onChange={(e) => setPrivacyPref('inviteEmbedsInEncrypted', e.target.checked)}
        />
        {' '}Show guild invites in DMs and group DMs straight away
      </label>
      <p className="vc-hint">
        A guild invite link in a message gets a card with the guild&apos;s name and picture. To fill
        it in, the app asks the Voicaw server about the invite, which tells the server which invite
        was in your end-to-end encrypted message. Turn this off and the card waits until you tap
        Show. Guild channels aren&apos;t encrypted, so their invites always show. Saved on this device.
      </p>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.sendTyping}
          onChange={(e) => setPrivacyPref('sendTyping', e.target.checked)}
        />
        {' '}Let others see when I&apos;m typing
      </label>
      <p className="vc-hint">
        While you write a message, the others in the chat see that you&apos;re typing. In DMs
        and group DMs this tells the Voicaw server when you&apos;re typing and to whom, though never
        what. Turn it off and nobody sees you typing; you still see others. Saved on this device.
      </p>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.youtubeEmbeds}
          onChange={(e) => setPrivacyPref('youtubeEmbeds', e.target.checked)}
        />
        {' '}Show YouTube videos straight away
      </label>
      <p className="vc-hint">
        A YouTube link in a message gets a player. Loading it tells YouTube your IP address and
        which video you were sent, even if you never play it. Turn this off and the player waits
        until you tap Play; nothing comes from YouTube before then. Saved on this device.
      </p>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.gifs}
          onChange={(e) => setPrivacyPref('gifs', e.target.checked)}
        />
        {' '}Show GIFs straight away
      </label>
      <p className="vc-hint">
        GIFs in messages, and the previews in the GIF picker, load from KLIPY, which sees your IP
        address and which GIFs you see (not the chat or its messages). Turn this off and each GIF
        waits until you tap Show, and the GIF picker asks before showing previews. Saved on this
        device.
      </p>
    </div>
  );
}
