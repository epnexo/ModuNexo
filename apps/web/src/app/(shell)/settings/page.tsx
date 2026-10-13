import type { Metadata } from "next";

export const metadata: Metadata = { title: "Settings" };

// Placeholder: the settings service and the appearance editor are a later feature (A3).
export default function SettingsPage() {
  return (
    <div className="flex max-w-xl flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="text-muted">Platform and module settings will be edited here. The theme can already be switched from the top bar.</p>
    </div>
  );
}
