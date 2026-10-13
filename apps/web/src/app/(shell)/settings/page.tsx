import { readTrustedProxyState, resolveMasterKey } from "@epnexo/core/auth";
import { AppearanceService, SettingsService } from "@epnexo/core/settings";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppearanceForm } from "../../../components/settings/appearance-form";
import { ModuleSettings } from "../../../components/settings/module-settings";
import { SecurityForm } from "../../../components/settings/security-form";
import { modules } from "../../../generated/modules";
import { platform } from "../../../server/platform";
import { enabledModuleIds, webRegistry } from "../../../server/registry";
import { resolveViewer } from "../../../server/viewer";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
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
  const trustedProxies = await readTrustedProxyState(pool);
  const settings = new SettingsService(pool, registry, { masterKey: resolveMasterKey() });
  const sections = await Promise.all(modules.filter((manifest) => enabled.has(manifest.id)).map(async (manifest) => ({ id: manifest.id, name: manifest.name, entries: await settings.describe(manifest.id) })));

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted">Everything here is stored by the platform; nothing needs an environment variable.</p>
      </div>

      <section aria-labelledby="appearance-heading" className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5">
        <h2 id="appearance-heading" className="text-lg font-semibold tracking-tight">
          Appearance
        </h2>
        <AppearanceForm initial={appearance.platform} canWrite={viewer.canWrite} />
      </section>

      <section aria-labelledby="security-heading" className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5">
        <h2 id="security-heading" className="text-lg font-semibold tracking-tight">
          Security
        </h2>
        <SecurityForm initial={trustedProxies.list} invalidStored={trustedProxies.invalid} canWrite={viewer.canWrite} />
      </section>

      {sections.length === 0 ? (
        <p className="text-sm text-muted">No modules are enabled, so there are no module settings yet.</p>
      ) : (
        sections.map((section) => (
          <ModuleSettings
            key={section.id}
            moduleId={section.id}
            name={section.name}
            entries={section.entries}
            override={appearance.modules[section.id] ?? {}}
            platform={{ accentHue: appearance.platform.accentHue, radius: appearance.platform.radius }}
            canWrite={viewer.canWrite}
          />
        ))
      )}
    </div>
  );
}
