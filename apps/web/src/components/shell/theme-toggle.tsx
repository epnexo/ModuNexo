"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "epnexo.theme";

const read = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

export function ThemeToggle() {
  // The page was rendered before the theme was known, so the label is only filled in once mounted.
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => setTheme(read()), []);

  function toggle() {
    const next: Theme = read() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private mode or blocked storage: the choice lasts until the page is closed.
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
      className="inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-panel-hover hover:text-foreground"
    >
      {theme === "dark" ? <Sun aria-hidden className="size-4" /> : <Moon aria-hidden className="size-4" />}
    </button>
  );
}
