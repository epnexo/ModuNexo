import type { Metadata } from "next";
import { BrandMark, brandName } from "../../components/brand/brand-mark";
import { loadBrand } from "../../server/brand";
import { AppearanceHead } from "../../components/appearance-head";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };
// The saved appearance is part of the page, so it is rendered per request, never at build time.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const brand = await loadBrand();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-6">
      <AppearanceHead />
      <div className="flex flex-col gap-3">
        {brand.profile === null ? null : <BrandMark profile={brand.profile} logo={brand.logo} size={48} showName={false} />}
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to {brandName(brand.profile)}</h1>
        <p className="text-muted">Use the administrator account created on the server.</p>
      </div>
      <LoginForm />
    </main>
  );
}
