"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

export interface PlatformAppearance {
  theme: "system" | "light" | "dark";
  accentHue: number;
  radius: "sharp" | "default" | "round";
}

const RADIUS_REM = { sharp: "0.25rem", default: "0.625rem", round: "1rem" } as const;
const THEME_LABEL = { system: "Follow the system", light: "Light", dark: "Dark" } as const;
const RADIUS_LABEL = { sharp: "Sharp", default: "Default", round: "Round" } as const;

export function AppearanceForm({ initial, canWrite }: { initial: PlatformAppearance; canWrite: boolean }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus(null);
    try {
      const response = await fetch("/api/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) {
        setStatus({ kind: "ok", text: "Saved." });
        router.refresh();
      } else {
        setStatus({ kind: "error", text: data.error ?? "Could not save the appearance." });
      }
    } catch {
      setStatus({ kind: "error", text: "Could not reach the server." });
    }
    setPending(false);
  }

  const field = "h-10 rounded-md border border-border-strong bg-surface px-3 outline-none transition-colors duration-150 focus-visible:border-accent disabled:opacity-60";

  return (
    <form onSubmit={save} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="appearance-theme" className="text-sm font-medium">
          Default theme
        </label>
        <select
          id="appearance-theme"
          value={values.theme}
          disabled={!canWrite || pending}
          onChange={(event) => setValues({ ...values, theme: event.target.value as PlatformAppearance["theme"] })}
          className={`${field} max-w-xs`}
        >
          {(Object.keys(THEME_LABEL) as (keyof typeof THEME_LABEL)[]).map((theme) => (
            <option key={theme} value={theme}>
              {THEME_LABEL[theme]}
            </option>
          ))}
        </select>
        <p className="text-sm text-muted">What a visitor sees until they switch the theme from the top bar.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="appearance-hue" className="text-sm font-medium">
          Accent color
        </label>
        <div className="flex max-w-md items-center gap-3">
          <input
            id="appearance-hue"
            type="range"
            min={0}
            max={360}
            step={1}
            value={values.accentHue}
            disabled={!canWrite || pending}
            onChange={(event) => setValues({ ...values, accentHue: Number(event.target.value) })}
            className="flex-1 accent-(--accent)"
            aria-describedby="appearance-hue-value"
          />
          <span aria-hidden className="size-8 shrink-0 rounded-md border border-border-strong" style={{ background: `oklch(0.55 0.15 ${values.accentHue})` }} />
          <output id="appearance-hue-value" className="w-10 text-right text-sm text-muted" data-numeric>
            {values.accentHue}
          </output>
        </div>
      </div>

      <fieldset className="flex flex-col gap-1.5" disabled={!canWrite || pending}>
        <legend className="mb-1.5 text-sm font-medium">Corners</legend>
        <div className="flex flex-wrap gap-3">
          {(Object.keys(RADIUS_LABEL) as (keyof typeof RADIUS_LABEL)[]).map((radius) => (
            <label
              key={radius}
              className={
                "flex cursor-pointer items-center gap-2 border px-3 py-2 text-sm transition-colors duration-150 " +
                (values.radius === radius ? "border-accent bg-accent-soft text-accent-soft-foreground" : "border-border-strong hover:bg-panel-hover")
              }
              style={{ borderRadius: RADIUS_REM[radius] }}
            >
              <input type="radio" name="radius" value={radius} checked={values.radius === radius} onChange={() => setValues({ ...values, radius })} className="accent-(--accent)" />
              {RADIUS_LABEL[radius]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!canWrite || pending}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent px-4 font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-70"
        >
          {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
          Save appearance
        </button>
        <p role="status" className={`text-sm ${status?.kind === "error" ? "text-danger" : "text-muted"}`}>
          {status?.text ?? (canWrite ? "" : "Only an administrator can change this.")}
        </p>
      </div>
    </form>
  );
}
