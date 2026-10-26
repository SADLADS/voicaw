import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { onPaneRequest, takePendingContent } from '../utils/mobilePanes';
import { isPanesPage } from '../utils/phoneHistory';
import { isTouchDragging } from './usePointerDrag';
import { OVERLAYS } from './useBackCloses';

// The phone layout's two panes, Discord style: the list (rail + conversations or channels)
// underneath, and the content (the chat) on top, which slides in from the right. A horizontal
// swipe drags it with the finger (the list moves a little behind it and dims); letting go
// finishes or undoes the slide depending on where it is and how fast it was flicked. A swipe
// only counts once it's clearly sideways, so scrolling messages never moves the panes.
//
// History: the content showing is a history entry of its own (`history.state[MARK]`, over the
// same URL), so the back button (and Android's back gesture) slides back to the list. MARK is
// 'pushed' when that entry was added over a list entry (going back to the list pops it), or
// 'replaced' when a navigation made while the chat showed was marked in place. On phones, going
// from one chat to another replaces the entry (utils/phoneHistory.js), so the list's entry
// keeps the page it last showed: going back to it shows the list of the chat just left (the
// guild's channels, or the DMs), as Discord does, not the one before. Panels over the chat with
// entries of their own (useBackCloses: the message box's emoji and + panels) are gone past in
// the same step, which closes them.
//
// The panes only have a transform while moving: at rest the one on screen has none, since a
// transform would become the containing block of everything `position: fixed` inside it.
//
// Smoothness: which pane shows isn't React state but classes on the wrapper (`pane-list` /
// `pane-content`) set here, once a slide comes to rest: letting go would otherwise re-render
// the whole Layout just as the slide starts. The pane off screen isn't hidden but covered (the
// list, under the chat) or moved off (the chat, to the right), so it stays painted and a
// drag's first frame has nothing new to paint; taps can't reach it there. It's `aria-hidden`
// for screen readers, not `inert` or `visibility: hidden`, which restyle the whole chat (tens
// of ms on a phone) each time they change.
//
// After letting go, the slide is a Web Animation laid out in advance (`springFrames`), which the
// browser runs on its compositor: stepping it from requestAnimationFrame on the page's thread
// dropped frames on phones once the finger was up (no more input to keep frames coming, and the
// history change re-rendering the page mid-slide), so a flick looked slower than a drag.
const MARK = 'voicawPane';
const DECIDE_PX = 8; // movement before a touch is judged sideways or not
const FLING_PX_PER_MS = 0.35; // a flick at least this fast goes its way, wherever it's let go
const PARALLAX = 0.3; // how far the list moves behind the content, as a share of the width
const SCRIM_OPACITY = 0.5;
const STIFFNESS = 520; // spring, critically damped (no bounce)
const OMEGA = Math.sqrt(STIFFNESS);
// A slide no finger set going (a tap on the back arrow or a conversation, the back button)
// starts at this share of the speed that would bring it in on a plain decelerating curve:
// from standing (as a spring left alone starts) it crept for its first frames, which felt like
// lag next to a flick, which carries the finger's speed. Under 1, so it never overshoots.
const TAP_SPEED = 0.6;
const FRAME_S = 1 / 120; // how finely the spring is laid out (the browser draws straight lines between)
// Touches that start in these don't move the panes (their own gestures, or panels over the chat;
// `[role="slider"]`: our own sliders, such as a video's seek bar or a voice message's waveform).
const NO_SWIPE = '.emoji-picker, .action-sheet-backdrop, .action-sheet, .member-list, .group-members, '
  + '[role="dialog"], input[type="range"], [role="slider"], [data-no-pane-swipe]';

const markOf = () => window.history.state?.[MARK];
const overlaysOf = () => window.history.state?.[OVERLAYS] ?? 0;

function setMark(kind, push) {
  const state = { ...window.history.state, [MARK]: kind };
  if (push) window.history.pushState(state, '');
  else window.history.replaceState(state, '');
}

function clearMark() {
  const { [MARK]: _, ...state } = window.history.state ?? {};
  window.history.replaceState(state, '');
}

function hide(el, hidden) {
  if (hidden) el?.setAttribute('aria-hidden', 'true');
  else el?.removeAttribute('aria-hidden');
}

// Where the spring has the panes `t` seconds after leaving `from` at `v` (px/s) for `target`,
// and how fast they're moving: the exact solution, not steps per frame. Stepping it (Euler)
// went unstable on slow frames (under ~45 fps, as while a phone draws the chat it slides in,
// or an iPhone in Low Power Mode): the pane shook back and forth for most of a second.
export function springAt(from, v, target, t) {
  const a = from - target;
  const b = v + OMEGA * a;
  const decay = Math.exp(-OMEGA * t);
  return { x: target + (a + b * t) * decay, v: (b - OMEGA * (a + b * t)) * decay };
}

// The spring from `from` (at `v` px/s) to `target`, laid out as positions every FRAME_S until it
// comes to rest there (the last one), held between 0 and `w`.
export function springFrames(from, v, target, w) {
  const xs = [];
  for (let t = 0; t < 3; t += FRAME_S) {
    const at = springAt(from, v, target, t);
    if (t > 0 && Math.abs(at.x - target) < 0.5 && Math.abs(at.v) < 30) break;
    xs.push(Math.min(Math.max(at.x, 0), w));
  }
  xs.push(target);
  return { xs, duration: (xs.length - 1) * FRAME_S * 1000 };
}

// The speed (px/s) a slide from `from` to `target` starts at when no finger set it going.
export function tapSpeed(from, target) {
  return TAP_SPEED * OMEGA * (target - from);
}

// Can `el` (or anything between it and `stop`) scroll sideways in the direction a finger
// moving by `dx` would scroll it? Then the swipe is its (here and in useSwipeToReply).
export function scrollsSideways(el, stop, dx) {
  for (let node = el; node && node !== stop; node = node.parentElement) {
    if (node.scrollWidth <= node.clientWidth + 1) continue;
    const overflow = getComputedStyle(node).overflowX;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    if (dx < 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1 : node.scrollLeft > 0) return true;
  }
  return false;
}

// `opensOnList`: the page has nothing for the content pane (/settings alone), so turning on
// there shows the list, with no entry of the content's own.
export function useSwipePanes({ enabled, opensOnList = false, wrapperRef, listRef, contentRef, scrimRef }) {
  // A fresh start opens on the chat (with the list behind it in history, see below).
  const paneRef = useRef('content');
  // x: the content's offset in px (0: showing, the width: off to the right), or where a slide
  // started; null at rest. A slide: its animations, and its spring's start, speed and target.
  const motion = useRef({ x: null, anims: null, from: 0, v: 0, target: null });
  const location = useLocation();
  const navigationType = useNavigationType();
  // In a ref: react-router makes a new one each navigation, and the popstate listener mustn't
  // be swapped while a popstate is being handled (the new one wouldn't hear it).
  const navigateRef = useRef(null);
  navigateRef.current = useNavigate();
  const lastMark = useRef(null);
  const contentPath = useRef(null); // the page the chat last showed
  const leavingContent = useRef(false); // slideTo went back from the chat's entry
  const clearingMark = useRef(false); // slideTo went back past panels to a 'replaced' entry
  const wasEnabled = useRef(null);

  const width = useCallback(() => wrapperRef.current?.clientWidth || window.innerWidth, [wrapperRef]);

  // The three moving parts' styles with the content at `x`.
  const styles = useCallback((x, w) => {
    const progress = 1 - x / w; // 1: content showing
    return [
      { transform: `translate3d(${x}px, 0, 0)` },
      { transform: `translate3d(${-progress * PARALLAX * w}px, 0, 0)` },
      { opacity: String(progress * SCRIM_OPACITY) },
    ];
  }, []);

  const paint = useCallback((x) => {
    wrapperRef.current?.classList.add('panes-moving');
    const [content, list, scrim] = styles(x, width());
    if (contentRef.current) contentRef.current.style.transform = content.transform;
    if (listRef.current) listRef.current.style.transform = list.transform;
    if (scrimRef.current) scrimRef.current.style.opacity = scrim.opacity;
  }, [width, styles, wrapperRef, contentRef, listRef, scrimRef]);

  // Where a slide has the content now.
  const sliding = useCallback(() => {
    const m = motion.current;
    const t = (m.anims[0].currentTime ?? 0) / 1000;
    return Math.min(Math.max(springAt(m.from, m.v, m.target, t).x, 0), width());
  }, [width]);

  // Stops a slide where it is, the panes held there by inline styles; the content's offset.
  const stop = useCallback(() => {
    const m = motion.current;
    if (m.anims) {
      m.x = sliding();
      paint(m.x);
      for (const anim of m.anims) anim.cancel();
      m.anims = null;
      m.target = null;
    }
    return m.x;
  }, [sliding, paint]);

  // Shows the chosen pane at rest (the classes the CSS hides the other one by). `on` false:
  // the phone layout is off, nothing hidden.
  const apply = useCallback((on = true) => {
    const showing = on ? paneRef.current : null;
    wrapperRef.current?.classList.toggle('pane-content', showing === 'content');
    wrapperRef.current?.classList.toggle('pane-list', showing === 'list');
    hide(listRef.current, showing === 'content');
    hide(contentRef.current, showing === 'list');
  }, [wrapperRef, listRef, contentRef]);

  const rest = useCallback(() => {
    const m = motion.current;
    for (const anim of m.anims ?? []) anim.cancel();
    m.anims = null;
    m.x = null;
    m.target = null;
    apply();
    wrapperRef.current?.classList.remove('panes-moving');
    for (const ref of [contentRef, listRef, scrimRef]) {
      if (ref.current) {
        ref.current.style.transform = '';
        ref.current.style.opacity = '';
      }
    }
  }, [apply, wrapperRef, contentRef, listRef, scrimRef]);

  // Picks the pane; it's shown when the panes next come to rest (now, if they aren't moving).
  const choose = useCallback((next) => {
    paneRef.current = next;
    // The chat shows this page now, even if the URL didn't change (swiped to from the list of a
    // guild opened on the rail): going back must keep it, not restore the chat shown before.
    if (next === 'content') contentPath.current = window.location.pathname;
    if (motion.current.x === null) apply();
  }, [apply]);

  // Slides to `next` from wherever the panes are (mid-drag, mid-slide or at rest), carrying
  // the finger's speed `v` (px/s; none: a tap's, TAP_SPEED). `fromHistory`: it's the
  // back/forward button, which already moved history.
  const slideTo = useCallback((next, { v, fromHistory = false } = {}) => {
    const m = motion.current;
    const w = width();
    const current = paneRef.current;
    const x0 = (m.anims ? sliding() : m.x) ?? (current === 'content' ? 0 : w);
    const target = next === 'content' ? 0 : w;

    if (!fromHistory && next !== current) {
      if (next === 'content') {
        // After the click that asked for it: a list row's link navigates (replacing its
        // entry) after its onClick has run, and the mark goes on the entry it makes.
        queueMicrotask(() => {
          if (paneRef.current === 'content' && !markOf()) {
            setMark('pushed', true);
            lastMark.current = 'pushed';
          }
        });
      } else if (markOf() === 'pushed') {
        leavingContent.current = true;
        window.history.go(-1 - overlaysOf()); // popstate lands here again, already on its way
      } else if (markOf() && overlaysOf()) {
        leavingContent.current = true;
        clearingMark.current = true;
        window.history.go(-overlaysOf()); // to the chat's entry, whose mark popstate then clears
      } else if (markOf()) {
        clearMark();
      }
    }
    if (next === 'list' && current === 'content') document.activeElement?.blur?.(); // keyboard down
    choose(next);

    if (m.target === target && m.anims) return;
    const content = contentRef.current;
    if (x0 === target || !content?.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      rest();
      return;
    }
    stop();
    paint(x0); // the moving state; the animations draw over these inline styles
    const speed = v ?? tapSpeed(x0, target);
    m.x = x0;
    m.from = x0;
    m.v = speed;
    m.target = target;
    const { xs, duration } = springFrames(x0, speed, target, w);
    const frames = xs.map((x) => styles(x, w));
    const timing = { duration, fill: 'forwards' };
    const anims = [content, listRef.current, scrimRef.current].map((el, i) => el?.animate(frames.map((f) => f[i]), timing)).filter(Boolean);
    m.anims = anims;
    anims[0].onfinish = () => {
      if (m.anims === anims) rest();
    };
  }, [width, choose, rest, paint, stop, styles, sliding, contentRef, listRef, scrimRef]);

  // Requests from elsewhere (showContent / showList).
  useEffect(() => {
    if (!enabled) return undefined;
    return onPaneRequest((next) => slideTo(next));
  }, [enabled, slideTo]);

  // Turning on: a fresh start marks its entry as the chat (so back shows the list), and so
  // does a chat opened from another page (Settings) with showContent(), such as a tapped
  // notification; coming back from another page shows whichever pane that entry had.
  useLayoutEffect(() => {
    if (!enabled) {
      if (wasEnabled.current) rest();
      apply(false);
      wasEnabled.current = wasEnabled.current === null ? null : false;
      return;
    }
    const opened = takePendingContent();
    if (opensOnList && !opened) {
      choose('list');
    } else if (wasEnabled.current === null || opened) {
      if (!markOf()) {
        setMark('pushed', true);
        lastMark.current = 'pushed';
      }
      choose('content');
    } else if (wasEnabled.current === false) {
      choose(markOf() ? 'content' : 'list');
    }
    apply();
    wasEnabled.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when turning on
  }, [enabled, choose, rest, apply]);

  // Back and forward: an entry with the mark is the chat, one without is the list.
  useEffect(() => {
    if (!enabled) return undefined;
    const onPopState = () => {
      if (clearingMark.current && markOf() && !overlaysOf()) clearMark();
      clearingMark.current = false;
      const next = markOf() ? 'content' : 'list';
      const fromContent = paneRef.current === 'content' || leavingContent.current;
      leavingContent.current = false;
      if (next !== paneRef.current) slideTo(next, { fromHistory: true });
      // The list's entry is behind the chat's: show the list of the chat just left.
      const path = contentPath.current;
      const here = window.location.pathname;
      if (next === 'list' && fromContent && path && path !== here && isPanesPage(here)) {
        navigateRef.current(path, { replace: true });
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [enabled, slideTo]);

  // The page the chat shows. A back to the list's entry renders (react-router hears popstate
  // first) before the panes know, so a pop counts only onto the chat's entry.
  useEffect(() => {
    if (!enabled || paneRef.current !== 'content' || (navigationType === 'POP' && !markOf())) return;
    contentPath.current = location.pathname;
  }, [enabled, location.key, location.pathname, navigationType]);

  // A navigation while the chat shows (a link in a message, an answered call) makes an entry
  // without the mark: mark it in place. A replace keeps the kind of the entry it replaced.
  useEffect(() => {
    if (!enabled || navigationType === 'POP' || paneRef.current !== 'content') return;
    const mark = markOf();
    if (mark) {
      lastMark.current = mark;
      return;
    }
    const kind = navigationType === 'REPLACE' ? lastMark.current ?? 'replaced' : 'replaced';
    setMark(kind, false);
    lastMark.current = kind;
  }, [enabled, location.key, navigationType]);

  // The swipe.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!enabled || !wrapper) return undefined;
    let touch = null; // { id, x0, y0, from, decided, samples }

    // Lets go of the panes: they slide to the side the finger left them nearer to, or the way
    // it was flicked (`samples`: its last positions).
    const release = (samples = []) => {
      const x = motion.current.x ?? 0;
      const w = width();
      // Speed over the last ~100ms (px/ms); an older sample would dull a quick flick.
      const recent = samples.filter((s) => samples.at(-1).t - s.t <= 100);
      const first = recent[0];
      const lastSample = recent.at(-1);
      const v = first && lastSample && lastSample.t > first.t ? (lastSample.x - first.x) / (lastSample.t - first.t) : 0;
      let next;
      if (v > FLING_PX_PER_MS) next = 'list';
      else if (v < -FLING_PX_PER_MS) next = 'content';
      else next = x > w / 2 ? 'list' : 'content';
      slideTo(next, { v: v * 1000 });
    };

    const onStart = (e) => {
      if (e.touches.length !== 1 || e.target.closest?.(NO_SWIPE)) {
        // A second finger (scrolling, pinching) mid-swipe: the swipe ends there, never
        // leaving the panes half way.
        if (touch?.decided) release();
        touch = null;
        return;
      }
      const t = e.touches[0];
      // Where the content is when the finger lands (caught mid-slide, it stops there).
      const x = stop();
      touch = {
        id: t.identifier,
        x0: t.clientX,
        y0: t.clientY,
        from: x ?? (paneRef.current === 'content' ? 0 : width()),
        // Panes that aren't at rest (sliding, or somehow left part way) are grabbed at once,
        // so even a tap settles them.
        decided: x !== null,
        samples: [],
      };
    };

    const onMove = (e) => {
      if (!touch) return;
      const t = [...e.touches].find((each) => each.identifier === touch.id);
      if (!t) return;
      const dx = t.clientX - touch.x0;
      const dy = t.clientY - touch.y0;
      if (!touch.decided) {
        if (Math.hypot(dx, dy) < DECIDE_PX) return;
        const sideways = Math.abs(dx) > Math.abs(dy) * 1.2;
        const allowed = touch.from === 0 ? dx > 0 : dx < 0;
        if (!sideways || !allowed || !e.cancelable || isTouchDragging() || scrollsSideways(e.target, wrapper, dx)) {
          touch = null;
          return;
        }
        touch.decided = true;
        touch.x0 = t.clientX; // no jump by the few pixels it took to decide
        wrapper.classList.add('panes-moving');
      }
      if (!e.cancelable) {
        // The browser is scrolling already and won't be stopped: let the panes go.
        const { samples } = touch;
        touch = null;
        release(samples);
        return;
      }
      e.preventDefault();
      const x = Math.min(Math.max(touch.from + t.clientX - touch.x0, 0), width());
      motion.current.x = x;
      touch.samples.push({ t: e.timeStamp, x });
      if (touch.samples.length > 8) touch.samples.shift();
      paint(x);
    };

    const onEnd = (e) => {
      if (!touch) return;
      if ([...e.touches].some((each) => each.identifier === touch.id)) return;
      const { decided, samples } = touch;
      touch = null;
      if (decided) release(samples);
    };

    wrapper.addEventListener('touchstart', onStart, { passive: true });
    wrapper.addEventListener('touchmove', onMove, { passive: false });
    wrapper.addEventListener('touchend', onEnd);
    wrapper.addEventListener('touchcancel', onEnd);
    return () => {
      wrapper.removeEventListener('touchstart', onStart);
      wrapper.removeEventListener('touchmove', onMove);
      wrapper.removeEventListener('touchend', onEnd);
      wrapper.removeEventListener('touchcancel', onEnd);
    };
  }, [enabled, wrapperRef, width, paint, slideTo, stop]);
}
