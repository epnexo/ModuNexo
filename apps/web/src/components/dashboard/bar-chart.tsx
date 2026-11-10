"use client";

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChartRow } from "../../server/dashboard";
import { barAnimation, barReadout, stepBar, valueAnimation } from "../../server/dashboard-live";

/**
 * One bar chart of the dashboard. The server sends the rows; this draws them as vertical bars with the value above each,
 * grows them from the base (see `barAnimation`) when the chart first shows, when its figures change and on Replay, and
 * opens the chart's screen when a bar is pressed. Hovering or focusing a bar reads it out (value and distance from the
 * average) and dims the others; the arrow keys, Home and End move between bars. With reduced motion the bars are simply there.
 */
export function BarChart({ chart }: { chart: ChartRow }) {
  const root = useRef<HTMLDivElement>(null);
  // What was last drawn, so a refresh that brings the same figures does not replay the animation.
  const drawn = useRef<string | null>(null);
  const signature = chart.bars.map((bar) => `${bar.label}:${bar.value}`).join("|");
  const [active, setActive] = useState<number | null>(null);
  const reading = active === null || chart.bars[active] === undefined ? null : barReadout(chart.bars[active].label, chart.bars[active].value, chart.average);

  const move = (event: React.KeyboardEvent<HTMLAnchorElement>, index: number) => {
    const next = stepBar(event.key, index, chart.bars.length);
    if (next === null) return;
    event.preventDefault();
    root.current?.querySelectorAll<HTMLAnchorElement>("[data-bar] a")[next]?.focus();
  };

  const play = useCallback(() => {
    const node = root.current;
    if (node === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    node.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
    node.querySelectorAll<HTMLElement>("[data-bar]").forEach((bar, index) => {
      const grow = barAnimation(index);
      bar.querySelector<HTMLElement>("[data-fill]")?.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: grow.duration, delay: grow.delay, easing: grow.easing, fill: "backwards" });
      const value = valueAnimation(index);
      bar.querySelector<HTMLElement>("[data-value]")?.animate([{ opacity: 0, translate: "0 5px" }, { opacity: 1, translate: "0 0" }], { duration: value.duration, delay: value.delay, easing: "ease-out", fill: "backwards" });
    });
  }, []);

  useEffect(() => {
    if (drawn.current === signature) return;
    drawn.current = signature;
    play();
  }, [signature, play]);

  return (
    <section aria-labelledby={`${chart.key}-title`} className="card flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`${chart.key}-title`} className="text-base font-semibold tracking-tight">
            {chart.label}
          </h3>
          <p className="text-sm text-muted">{chart.source}</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {chart.average === null ? null : (
            <span className="rounded-md bg-panel px-2 py-1">
              <span className="text-muted">Average </span>
              <strong className="tabular-nums">{chart.average.toLocaleString("en-US")}</strong>
            </span>
          )}
          <button
            type="button"
            onClick={play}
            disabled={chart.bars.length === 0}
            aria-label={`Replay the animation of ${chart.label}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-3 font-medium transition-colors duration-150 hover:bg-panel-hover disabled:opacity-50"
          >
            <RotateCcw aria-hidden className="size-4" />
            Replay
          </button>
        </div>
      </div>

      <p aria-live="polite" className="h-5 text-sm text-muted tabular-nums">
        {reading ?? (chart.available && chart.bars.length > 0 ? "Hover or focus a bar to read it. Arrow keys move between bars." : "")}
      </p>

      {!chart.available ? (
        <p className="text-sm text-muted">This chart is not available right now.</p>
      ) : chart.bars.length === 0 ? (
        <p className="text-sm text-muted">Nothing to show yet.</p>
      ) : (
        <div ref={root} className="overflow-x-auto pb-1" tabIndex={-1}>
          <ul className="flex h-56 items-end gap-2 border-b border-border pt-6" style={{ minWidth: `${chart.bars.length * 3}rem` }}>
            {chart.bars.map((bar, index) => {
              const height = chart.max === 0 ? 0 : Math.max(2, Math.round((bar.value / chart.max) * 100));
              return (
                <li key={bar.label} data-bar className="flex h-full min-w-10 flex-1 flex-col justify-end">
                  <Link
                    href={chart.href}
                    aria-label={`${barReadout(bar.label, bar.value, chart.average)}. Open ${chart.label}`}
                    onMouseEnter={() => setActive(index)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(index)}
                    onBlur={() => setActive(null)}
                    onKeyDown={(event) => move(event, index)}
                    className="group flex h-full flex-col items-center justify-end gap-1 rounded-md outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <span data-value className="text-xs font-semibold tabular-nums">
                      {bar.value.toLocaleString("en-US")}
                    </span>
                    <span className="flex w-full flex-1 items-end justify-center">
                      <span data-fill className={`w-full max-w-10 origin-bottom chart-fill rounded-t-sm transition-opacity duration-150 ${active !== null && active !== index ? "opacity-40" : ""}`} style={{ height: `${height}%` }} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <ul aria-hidden className="flex gap-2 pt-1" style={{ minWidth: `${chart.bars.length * 3}rem` }}>
            {chart.bars.map((bar) => (
              <li key={bar.label} className="min-w-10 flex-1 truncate text-center text-xs text-muted">
                {bar.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
