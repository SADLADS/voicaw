import { useContext, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ImageViewerContext } from '../contexts';
import { galleryAround, galleryItemOf } from '../utils/imageGallery';
import { fileNameOf, imageLinkIn, withoutImageLink } from '../utils/imageLink';

// A link to a picture in a chat (utils/imageLink.js, the desktop app's Open Image): once chat
// `chatId` has loaded (`ready`), if the link is for it and for this account (`userId`; another
// account's link waits for ImageLinkAccount), takes the link out of the address, scrolls to the
// message (`jumpToMessage`, ChatPane's) and opens the picture in the viewer with the message's
// others. A picture that isn't there any more (or is still hidden as a spoiler) leaves the chat
// at the message.
export function useImageLink({ chatId, userId, ready, jumpToMessage }) {
  const location = useLocation();
  const navigate = useNavigate();
  const viewer = useContext(ImageViewerContext);
  const link = imageLinkIn(location.search);
  const wanted = ready && link && link.chatId === String(chatId) && link.as === String(userId) ? link : null;
  const key = wanted ? `${wanted.messageId}/${wanted.file}` : null;

  useEffect(() => {
    if (!wanted) return;
    navigate({ pathname: location.pathname, search: withoutImageLink(location.search) }, { replace: true, state: location.state });
    jumpToMessage(wanted.messageId).then((row) => {
      const element = row && [...row.querySelectorAll('[data-gallery-item]')]
        .find((each) => fileNameOf(galleryItemOf(each)?.src) === wanted.file);
      if (element) viewer?.openImage(galleryAround(element));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
