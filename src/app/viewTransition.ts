import type { MouseEvent } from 'react';
import { flushSync } from 'react-dom';

/**
 * The group opening animation: the tapped Home card (and its ring) grows into the group page's
 * hero using the View Transitions API, and shrinks back on the way home. Styling only — the
 * navigation itself is the same `navigate()` call a plain link makes. Where the API is missing
 * (or reduced motion is on) the link simply navigates.
 */

type Navigate = (to: string) => void;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function canTransition(): boolean {
  return typeof document.startViewTransition === 'function' && !prefersReducedMotion();
}

/** Plain left clicks only: cmd/ctrl/shift-click keep their usual browser behaviour. */
export function shouldAnimateClick(e: MouseEvent): boolean {
  return (
    canTransition() &&
    !e.defaultPrevented &&
    e.button === 0 &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey
  );
}

/** Resolves once `selector` is on the page (the new page may still be loading its data). */
function waitFor(selector: string, timeoutMs = 600): Promise<HTMLElement | null> {
  const found = () => document.querySelector<HTMLElement>(selector);
  return new Promise((resolve) => {
    if (found()) return resolve(found());
    const observer = new MutationObserver(() => {
      if (!found()) return;
      done();
    });
    const timer = window.setTimeout(() => done(), timeoutMs);
    function done() {
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(found());
    }
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

function setNames(card: HTMLElement | null): HTMLElement[] {
  const ring = card?.querySelector<HTMLElement>('.ring') ?? null;
  if (card) card.style.viewTransitionName = 'group-card';
  if (ring) ring.style.viewTransitionName = 'group-ring';
  return [card, ring].filter((el): el is HTMLElement => el !== null);
}

function run(direction: 'forward' | 'back', update: () => Promise<HTMLElement[]>) {
  const root = document.documentElement;
  root.dataset.nav = direction;
  let named: HTMLElement[] = [];
  const transition = document.startViewTransition(async () => {
    named = await update();
  });
  // A skipped transition (e.g. another tap mid-way) still navigates; it just doesn't animate.
  transition.ready.catch(() => {});
  void transition.finished.finally(() => {
    delete root.dataset.nav;
    for (const el of named) el.style.viewTransitionName = '';
  });
}

/** Where Home was scrolled to, so coming back lands on the card you opened. */
let homeScrollY = 0;

export function openGroup(navigate: Navigate, to: string, card: HTMLElement) {
  homeScrollY = window.scrollY;
  // Names go on before the old page is captured; the card disappears with Home.
  setNames(card);
  run('forward', async () => {
    flushSync(() => navigate(to));
    await waitFor('.group-hero');
    window.scrollTo(0, 0);
    return [];
  });
}

export function backToHome(navigate: Navigate, bucket: string) {
  run('back', async () => {
    flushSync(() => navigate('/'));
    const card = await waitFor(`a.group-card[href$="/group/${bucket}"]`);
    window.scrollTo(0, homeScrollY);
    if (!card) return [];
    // Only morph into the card if it's on screen; otherwise the page just cross-fades.
    const box = card.getBoundingClientRect();
    return box.bottom > 0 && box.top < window.innerHeight ? setNames(card) : [];
  });
}
