import { sendGroupMessage } from './groupService';
import { encryptGroupMessage, groupMessageContext, messageSignatureContext } from './groupCrypto';
import { loadIdentityKey } from './keyStore';
import { currentEpoch } from './groupKeys';
import { uploadNamesIn } from '../utils/attachmentMarkup';

// Sends `text` to a group DM: encrypted (and signed) with the current epoch, made first if the
// members changed. A 409 means the members changed meanwhile: once more with a fresh epoch.
// Used by the open group (useGroupConversation) and the share screen (services/chatSend.js).
// - `opened`: the group as openGroup returned it, if already open (else it's opened here)
// - `onOpened(group)`: the group each attempt used; `reopen()` opens it again after a 409
// -> { message (the server's row), key (the epoch's key, for its link previews) }
export async function sendGroupText(me, groupId, text, { replyToId = null, nonce, opened = null, onOpened, reopen } = {}) {
  let group = opened;
  for (let attempt = 0; ; attempt++) {
    const { epoch, key, group: current } = await currentEpoch(me, groupId, group);
    onOpened?.(current);
    const content = await encryptGroupMessage(
      text, key, groupMessageContext(groupId, epoch, me.id), await loadIdentityKey(),
      messageSignatureContext({ groupId, epoch, senderId: me.id, replyTo: replyToId })
    );
    try {
      return { message: await sendGroupMessage(groupId, epoch, content, replyToId, uploadNamesIn(text), nonce), key };
    } catch (err) {
      if (err.response?.status !== 409 || attempt === 1) throw err;
      group = reopen ? await reopen() : null;
    }
  }
}
