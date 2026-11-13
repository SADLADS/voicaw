import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// A chat opened with `state.jumpToMessage: { chatId, messageId }` (the corner video's Go to
// message, components/FloatingVideo.jsx) scrolls to that message once it has loaded (older
// history too, by `jumpToMessage`). Only the chat it names, once; the state is cleared so Back
// and reloads don't jump again.
export function useLocationJump({ chatId, ready, jumpToMessage }) {
  const location = useLocation();
  const navigate = useNavigate();
  const target = location.state?.jumpToMessage;
  useEffect(() => {
    if (!ready || target?.messageId == null || String(target.chatId) !== String(chatId)) return;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    jumpToMessage(target.messageId);
    // jumpToMessage is made anew each render; the target is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, target, chatId]);
}
