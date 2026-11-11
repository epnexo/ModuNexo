import { readTrustedProxyState, resolveMasterKey } from "@modunexo/core/auth";
import { ApiAddressService, normalizeApiAddress, resolveApiAddress } from "@modunexo/core/api-access";
import { AppearanceService, SettingsService, readBrand } from "@modunexo/core/settings";
import { TokenService } from "@modunexo/core/tokens";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Tabs } from "../../../components/ui/tabs";
import { BrandForm } from "../../../components/settings/brand-form";
import { AppearanceForm } from "../../../components/settings/appearance-form";
import { ResetIdentity } from "../../../components/settings/reset-identity";
import { McpPanel } from "../../../components/settings/mcp-panel";
import { ApiAccess } from "../../../components/settings/api-access";
import { ModulePicker } from "../../../components/settings/module-picker";
import { SettingsSearch } from "../../../components/settings/settings-search";
import { ConnectionChecks } from "../../../components/settings/connection-checks";
import { ModuleSettings } from "../../../components/settings/module-settings";
import { SecurityForm } from "../../../components/settings/security-form";
import { modules } from "../../../generated/modules";
import { resolvePublicUrl } from "../../../server/launch";
import { buildAccessView } from "../../../server/api-access-view";
import { buildChecksView } from "../../../server/connection-checks";
import { mcpConnection } from "../../../server/mcp-connection";
import { pickModule } from "../../../server/module-picker";
import { buildSettingsIndex } from "../../../server/settings-index";
import { platform } from "../../../server/platform";
import { enabledModuleIds, webRegistry } from "../../../server/registry";
import { resolveViewer } from "../../../server/viewer";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/** `WEB_PUBLIC_URL` as an origin, or undefined when it is unset or malformed (the settings page must still open). */
function publicUrlOrigin(): string | undefined {
  try {
    return resolvePublicUrl().baseURL;
  } catch {
    return undefined;
  }
}

/** The address this page was reached at, from the Host header, or null when it cannot be read as one. */
function requestOrigin(requestHeaders: Headers): string | null {
  const host = requestHeaders.get("host");
  if (host === null) return null;
  try {
    return normalizeApiAddress(`${cookiesAreSecure() ? "https" : "http"}://${host}`);
  } catch {
    return null;
  }
}

/** Whether session cookies are marked Secure. A malformed `WEB_PUBLIC_URL` is reported as not secure, never thrown. */
function cookiesAreSecure(): boolean {
  try {
    return resolvePublicUrl().secureCookies;
  } catch {
    return false;
  }
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ module?: string | string[] }> }) {
  const viewer = await resolveViewer(await headers());
  if (viewer === null) redirect("/login");

  if (!viewer.canWrite) {
    return (
      <div className="flex max-w-xl flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted">Only an administrator can view or change settings.</p>
      </div>
    );
  }

  const { pool } = platform();
  const registry = webRegistry();
  const enabled = await enabledModuleIds(pool);
  const appearance = await new AppearanceService(pool, registry).get();
  const brand = await readBrand(pool);
  const trustedProxies = await readTrustedProxyState(pool);
  const settings = new SettingsService(pool, registry, { masterKey: resolveMasterKey() });
  const tokens = new TokenService(pool, registry);
  const address = resolveApiAddress({ saved: await new ApiAddressService(pool).get(), publicUrl: publicUrlOrigin(), requestOrigin: requestOrigin(await headers()) });
  const now = new Date();
  // Only the module that is open is described and rendered: its settings, its token list and its HTML are the cost of one
  // module, however many are installed. The id comes from the address, so it is checked against the enabled modules.
  const enabledModules = modules.filter((manifest) => enabled.has(manifest.id)).map((manifest) => ({ id: manifest.id, name: manifest.name }));
  const selectedId = pickModule(enabledModules, (await searchParams).module);
  // Which modules still have a required setting to fill in: a count per module, no values, no rendering.
  const pickerEntries = await Promise.all(enabledModules.map(async (entry) => ({ ...entry, needs: (await settings.incomplete(entry.id)).length })));
  const settingsIndex = buildSettingsIndex(modules, enabled);
  const selectedManifest = selectedId === null ? undefined : modules.find((manifest) => manifest.id === selectedId);
  const selected =
    selectedManifest === undefined
      ? null
      : {
          id: selectedManifest.id,
          name: selectedManifest.name,
          entries: await settings.describe(selectedManifest.id),
          checks: buildChecksView(selectedManifest),
          access: buildAccessView({
            manifest: selectedManifest,
            tokens: (selectedManifest.scopes ?? []).length > 0 ? await tokens.list(selectedManifest.id) : [],
            address,
            now,
          }),
        };

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-muted">Everything here is stored by the platform; nothing needs an environment variable.</p>
        </div>
        <SettingsSearch index={settingsIndex} />
      </div>

      <Tabs
        label="Settings"
        tabs={[
          { id: "profile", label: "Profile", content: (<>
      <section aria-labelledby="profile-heading" className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5">
        <div className="flex flex-col gap-1">
          <h2 id="profile-heading" className="text-lg font-semibold tracking-tight">
            Profile
          </h2>
          <p className="text-sm text-muted">Who this platform belongs to. It replaces the default name in the sidebar, the sign-in page and the page titles.</p>
        </div>
        <BrandForm mode="edit" initial={brand.profile} logo={brand.logo} canWrite={viewer.canWrite} />
        {brand.profile === null ? null : <ResetIdentity name={brand.profile.name} />}
      </section>

          </>) },
          { id: "appearance", label: "Appearance", content: (<>
      <section aria-labelledby="appearance-heading" className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5">
        <h2 id="appearance-heading" className="text-lg font-semibold tracking-tight">
          Appearance
        </h2>
        <AppearanceForm initial={appearance.platform} canWrite={viewer.canWrite} />
      </section>

          </>) },
          { id: "security", label: "Security", content: (<>
      <section aria-labelledby="security-heading" className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5">
        <h2 id="security-heading" className="text-lg font-semibold tracking-tight">
          Security
        </h2>
        {cookiesAreSecure() ? null : (
          <p role="note" className="max-w-xl rounded-md bg-warning-soft px-3 py-2 text-sm">
            Session cookies are not marked Secure because <code className="font-mono">WEB_PUBLIC_URL</code> is not an https address. That is fine on a trusted
            local network. If you reach this app over HTTPS, set <code className="font-mono">WEB_PUBLIC_URL</code> (for example{" "}
            <code className="font-mono">https://modunexo.example.com</code>) and restart, so the cookie is never sent over plain HTTP.
          </p>
        )}
        <SecurityForm initial={trustedProxies.list} invalidStored={trustedProxies.invalid} canWrite={viewer.canWrite} />
      </section>

          </>) },
          { id: "mcp", label: "MCP", content: <McpPanel view={mcpConnection()} /> },
          { id: "modules", label: "Modules", content: (<>
      {selected === null ? (
        <p className="text-sm text-muted">No modules are enabled, so there are no module settings yet.</p>
      ) : (
        <ModulePicker entries={pickerEntries} selected={selected.id}>
          <ModuleSettings
            key={selected.id}
            moduleId={selected.id}
            name={selected.name}
            entries={selected.entries}
            override={appearance.modules[selected.id] ?? {}}
            platform={{ accentHue: appearance.platform.accentHue, radius: appearance.platform.radius }}
            canWrite={viewer.canWrite}
          />
          {selected.checks.length === 0 ? null : <ConnectionChecks key={`${selected.id}-checks`} moduleId={selected.id} name={selected.name} checks={selected.checks} canWrite={viewer.canWrite} />}
          {selected.access === null ? null : <ApiAccess key={`${selected.id}-access`} moduleId={selected.id} name={selected.name} view={selected.access} canWrite={viewer.canWrite} />}
        </ModulePicker>
      )}
          </>) },
        ]}
      />
    </div>
  );
}
