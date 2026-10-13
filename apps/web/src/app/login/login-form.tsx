"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { authClient } from "../../lib/auth-client";

type Failure = "credentials" | "throttled" | "unavailable";

const MESSAGES: Record<Failure, string> = {
  credentials: "Wrong email or password.",
  throttled: "Too many attempts. Wait a minute and try again.",
  unavailable: "Could not sign in right now. Try again in a moment.",
};

export function LoginForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setFailure(null);
    try {
      const { error } = await authClient.signIn.email({ email: String(data.get("email") ?? ""), password: String(data.get("password") ?? "") });
      if (error === null) {
        router.replace("/");
        router.refresh();
        return;
      }
      setFailure(error.status === 401 ? "credentials" : error.status === 429 ? "throttled" : "unavailable");
    } catch {
      setFailure("unavailable");
    }
    setPending(false);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          autoFocus
          required
          disabled={pending}
          className="h-10 rounded-md border border-border-strong bg-surface px-3 outline-none transition-colors duration-150 focus-visible:border-accent disabled:opacity-60"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
          className="h-10 rounded-md border border-border-strong bg-surface px-3 outline-none transition-colors duration-150 focus-visible:border-accent disabled:opacity-60"
        />
      </div>
      <p role="alert" className="min-h-5 text-sm text-danger">
        {failure === null ? "" : MESSAGES[failure]}
      </p>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent px-4 font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-70"
      >
        {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
        {pending ? "Signing in" : "Sign in"}
      </button>
    </form>
  );
}
