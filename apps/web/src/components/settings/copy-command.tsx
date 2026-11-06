"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** A command in a block with a button that copies it. Without clipboard access the text stays selectable. */
export function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The block is selectable by hand.
    }
  }

  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background p-3">
      <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed">{command}</code>
      <button type="button" onClick={copy} aria-label={`Copy: ${label}`} className="shrink-0 rounded-md border border-border p-1.5 text-muted hover:text-foreground">
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
    </div>
  );
}
