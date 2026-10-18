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
