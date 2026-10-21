export interface HeaderEntry {
  key: string;
  value: string;
}

/**
 * Headers every response carries. The content policy leaves `script-src` and `default-src` out on purpose: the
 * app has inline scripts (the theme bootstrap, Next's own), and a policy that restricted them would break pages.
 * What it does forbid is being framed, plugins, a changed `<base>` and forms posting elsewhere. HSTS is sent only
 * when the app is served over https, because browsers ignore it on plain HTTP.
 */
export function securityHeaders(https: boolean): HeaderEntry[] {
  const headers: HeaderEntry[] = [
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "same-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
    { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  ];
  if (https) headers.push({ key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" });
  return headers;
}

export interface HeaderRule {
  source: string;
  headers: HeaderEntry[];
}

/**
 * Paths whose route sends a content policy of its own (`default-src 'none'; sandbox`, so what it serves cannot run
 * anything): a stored file and the logo. `skip` is what the first rule must not match for that path.
 */
const OWN_POLICY = [
  { source: "/api/files/:path*", skip: "api/files/" },
  { source: "/api/brand/logo", skip: "api/brand/logo$" },
] as const;

/**
 * What `next.config` applies. A header set there replaces one the route set itself, so the paths in `OWN_POLICY` are left out
 * of the first rule and get the same headers without the content policy in a rule of their own, which lets the route's
 * policy reach the browser.
 */
export function headerRules(https: boolean): HeaderRule[] {
  const all = securityHeaders(https);
  const withoutPolicy = all.filter((header) => header.key !== "Content-Security-Policy");
  return [
    { source: `/:path((?!${OWN_POLICY.map((path) => path.skip).join("|")}).*)`, headers: all },
    ...OWN_POLICY.map((path) => ({ source: path.source, headers: withoutPolicy })),
  ];
}
