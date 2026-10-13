import { readSignInMode } from "@epnexo/core/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignOutButton } from "../components/sign-out-button";
import { platform } from "../server/platform";

// Placeholder until the shell layout lands (task T4 of shell-ui-auth). It already shows who is signed in and
// ends the session, because a sign-in page without a sign-out is not shippable.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { pool, auth } = platform();
  const mode = await readSignInMode(pool);
  const session = mode === "required" ? await auth.api.getSession({ headers: await headers() }) : null;
  // The proxy has already refused a visitor without a session; this is the same rule at the point of use.
  if (mode === "required" && session === null) redirect("/login");

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold tracking-tight">epnexo</h1>
      {session !== null ? (
        <>
          <p className="text-muted">
            Signed in as <span className="font-medium text-foreground">{session.user.email}</span>.
          </p>
          <div>
            <SignOutButton />
          </div>
        </>
      ) : (
        <p className="text-muted">Sign-in is switched off. This shell serves the local network only.</p>
      )}
    </main>
  );
}
