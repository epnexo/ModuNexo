import type { PublicUrl } from "./launch.ts";

/**
 * True when a request evidently came over HTTPS (a proxy says so, or the browser's Origin is https) while the
 * session cookie is not marked Secure because `WEB_PUBLIC_URL` is not an https origin. Cookies still work, but a
 * browser would also send them over plain HTTP to the same host, so the operator is told once. It is a hint only:
 * both headers can be written by a client, and the worst a forged one can do is cause a log line.
 */
export function servedOverHttpsWithoutPublicUrl(headers: Pick<Headers, "get">, publicUrl: PublicUrl): boolean {
  if (publicUrl.secureCookies) return false;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const origin = headers.get("origin")?.trim().toLowerCase();
  return proto === "https" || (origin !== undefined && origin.startsWith("https://"));
}
