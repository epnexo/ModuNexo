import { readTrustedProxyState, resolveMasterKey } from "@modunexo/core/auth";
import { AppearanceService, SettingsService, readBrand } from "@modunexo/core/settings";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Tabs } from "../../../components/ui/tabs";
import { BrandForm } from "../../../components/settings/brand-form";
import { AppearanceForm } from "../../../components/settings/appearance-form";
import { ResetIdentity } from "../../../components/settings/reset-identity";
import { ModuleSettings } from "../../../components/settings/module-settings";
import { SecurityForm } from "../../../components/settings/security-form";
import { modules } from "../../../generated/modules";
import { resolvePublicUrl } from "../../../server/launch";
import { platform } from "../../../server/platform";
import { enabledModuleIds, webRegistry } from "../../../server/registry";
import { resolveViewer } from "../../../server/viewer";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/** Whether session cookies are marked Secure. A malformed `WEB_PUBLIC_URL` is reported as not secure, never thrown. */
function cookiesAreSecure(): boolean {
  try {
    return resolvePublicUrl().secureCookies;
  } catch {
    return false;
  }
}

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
  const brand = await readBrand(pool);
  const trustedProxies = await readTrustedProxyState(pool);
  const settings = new SettingsService(pool, registry, { masterKey: resolveMasterKey() });
  const sections = await Promise.all(modules.filter((manifest) => enabled.has(manifest.id)).map(async (manifest) => ({ id: manifest.id, name: manifest.name, entries: await settings.describe(manifest.id) })));

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted">Everything here is stored by the platform; nothing needs an environment variable.</p>
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
          { id: "modules", label: "Modules", content: (<>
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
          </>) },
        ]}
      />
    </div>
  );
}
