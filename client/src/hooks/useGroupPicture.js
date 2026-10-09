import { useEffect, useState } from 'react';
import { groupPictureUrl } from '../services/groupPictures';

// The blob URL of a group's picture (`picture`: { id, key } from its name record), or null
// while it loads, when it has none or when it can't be read.
export function useGroupPicture(groupId, picture) {
  const [shown, setShown] = useState(null); // { id, url }
  const id = picture?.id;
  const key = picture?.key;
  useEffect(() => {
    if (!groupId || !id) return undefined;
    let current = true;
    groupPictureUrl(groupId, { id, key })
      .then((url) => { if (current) setShown({ id, url }); })
      .catch((err) => console.warn(`Group ${groupId}: can't show its picture`, err));
    return () => { current = false; };
  }, [groupId, id, key]);
  return shown && shown.id === id ? shown.url : null;
}
