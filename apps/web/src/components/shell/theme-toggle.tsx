"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

type Theme = "light" | "dark";
import { THEME_STORAGE_KEY } from "../../lib/theme";
import { REVEAL_EASING, REVEAL_MS, canReveal, revealClip } from "../../lib/theme-reveal";

const read = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

export function ThemeToggle() {
  // The page was rendered before the theme was known, so the label is only filled in once mounted.
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => setTheme(read()), []);

  const button = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);

  function apply(next: Theme) {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private mode or blocked storage: the choice lasts until the page is closed.
    }
    // Flushed so the new icon is part of the snapshot the browser reveals.
    flushSync(() => setTheme(next));
  }

  async function toggle() {
    if (busy.current) return;
    const next: Theme = read() === "dark" ? "light" : "dark";
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!canReveal(typeof document.startViewTransition === "function", reduced) || button.current === null) {
      apply(next);
      return;
    }
    // The new theme is revealed by a circle that grows from the button.
    busy.current = true;
    const clip = revealClip(button.current.getBoundingClientRect(), window.innerWidth, window.innerHeight);
    try {
      const transition = document.startViewTransition(() => apply(next));
      await transition.ready;
      document.documentElement.animate({ clipPath: [clip.from, clip.to] }, { duration: REVEAL_MS, easing: REVEAL_EASING, pseudoElement: "::view-transition-new(root)" });
      await transition.finished;
    } catch {
      // The transition was skipped or interrupted: the theme is already applied (or apply it now).
      if (read() !== next) apply(next);
    } finally {
      busy.current = false;
    }
  }

  return (
    <button
      ref={button}
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
      className="inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-panel-hover hover:text-foreground"
    >
      {theme === "dark" ? <Sun aria-hidden className="size-4" /> : <Moon aria-hidden className="size-4" />}
    </button>
  );
}
