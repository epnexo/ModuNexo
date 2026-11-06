"use client";

import { useState } from "react";
import type { ConnectionCommand } from "../../server/mcp-connection";
import { CopyCommand } from "./copy-command";

type Where = "docker" | "repo";

const WHERE: { id: Where; label: string; hint: string }[] = [
  { id: "docker", label: "Docker", hint: "The platform runs with docker compose" },
  { id: "repo", label: "A checkout", hint: "The platform runs from the repository" },
];

const ACCESS: { write: boolean; label: string; hint: string }[] = [
  { write: false, label: "Look only", hint: "Read data and check health. Changes nothing." },
  { write: true, label: "Look and change", hint: "Also enable or disable modules, queue jobs, publish events." },
];

/** Two choices, one command to copy, one way to check it worked. */
export function McpConnect({ commands }: { commands: ConnectionCommand[] }) {
  const [where, setWhere] = useState<Where>("docker");
  const [write, setWrite] = useState(false);
  const current = commands.find((item) => item.id === `${where}-${write ? "write" : "read"}`)!;

  return (
    <div className="flex flex-col gap-5">
      <Choice legend="1. Where does the platform run?" name="where" value={where} onChange={setWhere} options={WHERE.map((o) => ({ value: o.id, label: o.label, hint: o.hint }))} />
      <Choice
        legend="2. What may Claude do?"
        name="access"
        value={write ? "write" : "read"}
        onChange={(value) => setWrite(value === "write")}
        options={ACCESS.map((o) => ({ value: o.write ? "write" : "read", label: o.label, hint: o.hint }))}
      />
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">3. Run this where Claude Code is</h3>
        <CopyCommand command={current.command} label="the connect command" />
        {where === "repo" ? <p className="text-xs text-muted">Replace /path/to/repository with the folder of this platform.</p> : null}
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">4. Check</h3>
        <p className="text-sm text-muted">
          In Claude Code type <code className="font-mono text-xs">/mcp</code>: <code className="font-mono text-xs">modunexo</code> should show as connected.
        </p>
      </div>
    </div>
  );
}

function Choice<T extends string>({ legend, name, value, onChange, options }: { legend: string; name: string; value: T; onChange: (value: T) => void; options: { value: T; label: string; hint: string }[] }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-semibold">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={`flex cursor-pointer flex-col gap-0.5 rounded-md border p-3 text-sm ${value === option.value ? "border-accent bg-accent-soft" : "border-border hover:bg-panel-hover"}`}
          >
            <span className="flex items-center gap-2 font-medium">
              <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
              {option.label}
            </span>
            <span className="pl-6 text-xs text-muted">{option.hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
