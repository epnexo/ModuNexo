import { NEVER_OFFERED, TOOLS } from "@modunexo/core/mcp-tools";

/** The container name `docker-compose.yml` gives the web service. */
const CONTAINER = "modunexo-web";
const WRITE = "MODUNEXO_MCP_WRITE=1";

export interface ConnectionCommand {
  id: "docker-read" | "docker-write" | "repo-read" | "repo-write";
  label: string;
  /** What this variant needs from the machine, shown under the command. */
  note: string;
  command: string;
  write: boolean;
}

export interface ToolInfo {
  name: string;
  description: string;
}

/**
 * What the MCP screen shows: the commands that register the server in Claude Code, and the tools by kind. The server
 * is local (stdio), so the platform cannot see a connection; these are the commands to run where Claude Code is.
 * Options go before the server name and the server command after `--`, as `claude mcp add` expects.
 */
export function mcpConnection() {
  // `--env` takes several KEY=value pairs, so an option must sit between it and the name or the name is read as a pair.
  const add = (env: string) => `claude mcp add ${env}--transport stdio modunexo`;
  const commands: ConnectionCommand[] = [
    {
      id: "docker-read",
      label: "Docker, read-only",
      note: `For a platform run with docker compose. Needs Docker on the machine that runs Claude Code and the container "${CONTAINER}" up.`,
      command: `${add("")} -- docker exec -i ${CONTAINER} npm run --silent mcp`,
      write: false,
    },
    {
      id: "docker-write",
      label: "Docker, with write tools",
      note: "The same, and it also allows enabling or disabling modules, queueing jobs and publishing events.",
      command: `${add(`--env ${WRITE} `)} -- docker exec -i -e ${WRITE} ${CONTAINER} npm run --silent mcp`,
      write: true,
    },
    {
      id: "repo-read",
      label: "Repository, read-only",
      note: "For a platform run from a checkout. Replace the path; the repository's .env supplies the database and the master key.",
      command: `cd /path/to/repository && ${add("")} -- npm run --silent mcp`,
      write: false,
    },
    {
      id: "repo-write",
      label: "Repository, with write tools",
      note: "The same, with the write tools allowed.",
      command: `cd /path/to/repository && ${add(`--env ${WRITE} `)} -- npm run --silent mcp`,
      write: true,
    },
  ];
  const info = (write: boolean): ToolInfo[] => TOOLS.filter((tool) => tool.write === write).map(({ name, description }) => ({ name, description }));
  return { commands, read: info(false), write: info(true), neverOffered: [...NEVER_OFFERED] };
}
