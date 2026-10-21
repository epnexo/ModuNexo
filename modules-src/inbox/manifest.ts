import { SDK_VERSION, defineModule } from "@modunexo/sdk";
import { DELIVER_ATTEMPTS } from "./lib/limits.ts";

export default defineModule({
  id: "inbox",
  version: "0.1.0", // raise it whenever a migration is added: an upgrade to the same version does nothing
  name: "Inbox",
  platform: `^${SDK_VERSION}`,
  dependsOn: {},
  schema: "inbox", // the Postgres schema this module owns
  migrationsDir: "migrations",
  permissions: [
    { key: "inbox.read", label: "Read conversations" },
    { key: "inbox.write", label: "Reply to conversations" },
  ],
  settings: [
    { key: "webhook_secret", label: "Webhook secret", type: "secret", required: true, description: "Shared key that signs the messages a channel sends to /hooks/inbox/messages." },
    { key: "outbound_url", label: "Outbound URL", type: "string", description: "Where a reply is sent. Leave empty to keep replies queued." },
    { key: "outbound_secret", label: "Outbound secret", type: "secret", description: "Shared key that signs the replies sent to the outbound URL." },
  ],
  events: [{ name: "message.received", permission: "inbox.read" }],
  jobs: [{ name: "deliver", entry: "./jobs/deliver.ts", timeoutSeconds: 30, maxAttempts: DELIVER_ATTEMPTS }],
  nav: [{ label: "Inbox", href: "/inbox", icon: "app", permission: "inbox.read" }],
  pages: [
    { path: "/inbox", entry: "./web/page.tsx", kind: "page", dynamic: "force-dynamic", permission: "inbox.read" },
    { path: "/inbox/reply", entry: "./web/reply.ts", kind: "route", methods: ["POST"], permission: "inbox.write" },
    {
      path: "/hooks/inbox/messages",
      entry: "./web/messages.ts",
      kind: "route",
      methods: ["POST"],
      public: { signature: { secret: "webhook_secret", header: "x-signature", encoding: "hex", prefix: "sha256=" }, ratePerMinute: 120, maxBodyBytes: 65536 },
    },
  ],
});
