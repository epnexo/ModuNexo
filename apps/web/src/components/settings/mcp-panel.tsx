import type { mcpConnection } from "../../server/mcp-connection";
import { McpConnect } from "./mcp-connect";

type View = ReturnType<typeof mcpConnection>;

/** Connect Claude Code to this platform in four steps. The detail of what it can do stays folded until asked for. */
export function McpPanel({ view }: { view: View }) {
  return (
    <section aria-labelledby="mcp-heading" className="flex max-w-2xl flex-col gap-6 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 id="mcp-heading" className="text-lg font-semibold tracking-tight">
          Connect Claude Code
        </h2>
        <p className="text-sm text-muted">Let Claude Code check and operate this platform. It takes one command.</p>
      </div>

      <McpConnect commands={view.commands} />

      <details className="rounded-md border border-border p-3 text-sm">
        <summary className="cursor-pointer font-medium">What can it do?</summary>
        <div className="mt-3 flex flex-col gap-3">
          <ToolChips title="Look" tools={view.read} />
          <ToolChips title="Change (only with “Look and change”)" tools={view.write} />
          <p className="text-xs text-muted">
            Never available: {view.neverOffered.map((item) => item.label).join(", ")}.
          </p>
        </div>
      </details>
    </section>
  );
}

function ToolChips({ title, tools }: { title: string; tools: View["read"] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <ul className="flex flex-wrap gap-1.5">
        {tools.map((tool) => (
          <li key={tool.name} title={tool.description} className="rounded border border-border px-1.5 py-0.5 font-mono text-xs">
            {tool.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
