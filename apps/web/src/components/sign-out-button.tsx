"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "../lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await authClient.signOut();
    } finally {
      // Even if the call failed the visitor is sent to the sign-in page, where the guard decides what is true.
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={pending}
      className="inline-flex h-9 items-center gap-2 rounded-md border border-border-strong px-3 text-sm transition-colors duration-150 hover:bg-panel-hover disabled:opacity-60"
    >
      <LogOut aria-hidden className="size-4" />
      Sign out
    </button>
  );
}
