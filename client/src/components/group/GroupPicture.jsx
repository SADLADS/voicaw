import React from 'react';
import { useGroupPicture } from '../../hooks/useGroupPicture';

// A group DM's picture (`picture` from its name record, see useGroupList), or `children` (the
// members' pictures, say) when it has none or it hasn't loaded.
export default function GroupPicture({ groupId, picture, className, children = null }) {
  const url = useGroupPicture(groupId, picture);
  return url ? <img src={url} alt="" className={className} draggable={false} /> : children;
}
