/** How long the new theme takes to be revealed. */
export const REVEAL_MS = 620;
export const REVEAL_EASING = "cubic-bezier(.35, .05, .18, 1)";

/** The reveal needs the browser's View Transitions and is skipped for anyone who asked for less motion. */
export function canReveal(hasViewTransitions: boolean, prefersReducedMotion: boolean): boolean {
  return hasViewTransitions && !prefersReducedMotion;
}

/** A circle that starts at the center of the button and grows until it covers the whole window. */
export function revealClip(button: { left: number; top: number; width: number; height: number }, width: number, height: number): { from: string; to: string } {
  const x = button.left + button.width / 2;
  const y = button.top + button.height / 2;
  const radius = Math.ceil(Math.hypot(Math.max(x, width - x), Math.max(y, height - y)));
  return { from: `circle(0px at ${x}px ${y}px)`, to: `circle(${radius}px at ${x}px ${y}px)` };
}

/** Where the circle is not available (a browser without View Transitions) the colors fade instead, so the change is still seen. */
export const FADE_MS = 400;
export function shouldFade(hasViewTransitions: boolean, prefersReducedMotion: boolean): boolean {
  return !hasViewTransitions && !prefersReducedMotion;
}
