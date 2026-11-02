import { sendMessageToUser, setLinkPreviews } from './dmService';
import { setGroupLinkPreviews } from './groupService';
import { sendChannelMessage } from './guildService';
import { sendGroupText } from './groupSend';
import { deriveConversationKey, deriveNotesKey, dmContext, encryptMessage } from './encryptionService';
import { loadEncryptionKey, loadIdentityKey, loadOwnPublicKeys } from './keyStore';
import { checkContactKeys } from './contactKeys';
import { dmPreviewsContext, groupPreviewsContext, groupPreviewsSignatureContext, sealDmPreviews, sealGroupPreviews } from './linkPreviewCrypto';
import { previewsFor } from './linkPreviewService';
import { uploadNamesIn } from '../utils/attachmentMarkup';
import { t } from '../i18n';

// Sends `text` to a chat without opening it (the share screen, components/ShareDialog.jsx),
// exactly as that chat's own message box would: encrypted in your notes, DMs and group DMs (with
// the same keys and checks: never a contact's key straight from the server), plain in a guild
// channel. `destination` is a useChatDestinations entry: { kind: 'notes' | 'dm' | 'group' |
// 'channel', person, group, channel }. `nonce`: the same on a retry, so the server saves it once.
// Resolves to the server's message; link previews follow (not awaited), as in an open chat.
export async function sendToChat(me, destination, text, { nonce } = {}) {
  switch (destination.kind) {
    case 'notes':
    case 'dm':
      return sendDm(me, destination.kind === 'notes' ? me : destination.person, text, nonce);
    case 'group': {
      const { message, key } = await sendGroupText(me, destination.group.id, text, { nonce });
      attachGroupPreviews(me, destination.group.id, message, key, text);
      return message;
    }
    case 'channel':
      return sendChannelMessage(destination.channel.id, text, null, null, nonce);
    default:
      throw new Error(`Unknown chat kind ${destination.kind}`);
  }
}

async function sendDm(me, person, text, nonce) {
  const notes = String(person.id) === String(me.id);
  const myKey = await loadEncryptionKey();
  if (!myKey) throw new Error(t('chat.noKeys'));
  let key;
  if (notes) {
    const own = await loadOwnPublicKeys();
    if (!own?.encryptionKey) throw new Error(t('chat.noKeys'));
    key = await deriveNotesKey(myKey, own.encryptionKey);
  } else {
    // Their keys changed (or are broken): only their chat can show that and let you accept them.
    const check = await checkContactKeys(me.id, person);
    if (!check.encryptionKey) throw new Error(t('chat.share.keysChanged'));
    key = await deriveConversationKey(myKey, check.encryptionKey);
  }
  const content = await encryptMessage(text, key, dmContext(me.id, person.id));
  const saved = await sendMessageToUser(person.id, content, null, uploadNamesIn(text), nonce);
  attachDmPreviews(me, person, saved, key, text);
  return saved;
}

// This device makes link previews for its own messages in encrypted chats (see Link previews
// in docs/messages.md), as useConversation and useGroupConversation do.
async function attachDmPreviews(me, person, saved, key, text) {
  try {
    const embeds = await previewsFor(text);
    if (!embeds.length) return;
    const envelope = await sealDmPreviews(embeds, saved.content, key, dmPreviewsContext(saved.id, me.id, person.id));
    if (envelope) await setLinkPreviews(saved.id, envelope);
  } catch (err) {
    console.warn('Could not add link previews', err?.message);
  }
}

async function attachGroupPreviews(me, groupId, saved, key, text) {
  try {
    const embeds = await previewsFor(text);
    if (!embeds.length) return;
    const at = [groupId, saved.epoch, saved.id, me.id];
    const previews = await sealGroupPreviews(
      embeds, saved.content, key, groupPreviewsContext(...at), await loadIdentityKey(), groupPreviewsSignatureContext(...at)
    );
    if (previews) await setGroupLinkPreviews(saved.id, previews);
  } catch (err) {
    console.warn('Could not add link previews', err?.message);
  }
}
