import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppearanceHead } from "../../components/appearance-head";
import { BrandForm } from "../../components/settings/brand-form";
import { loadBrand } from "../../server/brand";
import { resolveViewer } from "../../server/viewer";

export const metadata: Metadata = { title: "Set up" };
export const dynamic = "force-dynamic";

/** The first thing an administrator sees: whom this platform is for. It is chosen here once; Settings can edit the details, not the kind. */
export default async function SetupPage() {
  const viewer = await resolveViewer(await headers());
  if (viewer === null) redirect("/login");
  const brand = await loadBrand();
  if (brand.profile !== null) redirect("/");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center gap-8 px-6 py-12">
      <AppearanceHead />
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Set up your platform</h1>
        <p className="text-muted">Tell us whom this CRM is for. It sets the name, logo and details shown across the platform. You choose this once.</p>
      </div>
      {viewer.canWrite ? <BrandForm mode="setup" initial={null} logo={null} canWrite /> : <p className="text-muted">An administrator has to finish the setup.</p>}
    </main>
  );
}
