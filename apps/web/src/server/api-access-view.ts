import { type ApiAddressSource, serviceEndpoints } from "@modunexo/core/api-access";
import { type TokenRecord, tokenState } from "@modunexo/core/tokens";
import type { ModuleManifest } from "@modunexo/sdk";

/** One token as the screen shows it: plain strings, and nothing that could be used to call the API. */
export interface TokenView {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  state: "active" | "expired" | "revoked";
}

export interface AccessView {
  address: { value: string | null; source: ApiAddressSource };
  scopes: { key: string; label: string }[];
  endpoints: { method: string; url: string; scopeLabel: string }[];
  tokens: TokenView[];
}

const ORDER = { active: 0, expired: 1, revoked: 2 } as const;

/**
 * What the "API access" block of a module needs, or null for a module that declares no scopes and so has no API.
 * Active tokens come first, the newest first, so the one in use is where the eye lands.
 */
export function buildAccessView(input: {
  manifest: Pick<ModuleManifest, "pages" | "scopes">;
  tokens: TokenRecord[];
  address: { address: string | null; source: ApiAddressSource };
  now: Date;
}): AccessView | null {
  const scopes = input.manifest.scopes ?? [];
  if (scopes.length === 0) return null;
  const base = input.address.address ?? "";
  const tokens = input.tokens
    .map((record): TokenView => ({
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      scopes: record.scopes,
      createdBy: record.createdBy,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt?.toISOString() ?? null,
      lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
      state: tokenState(record, input.now),
    }))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  return {
    address: { value: input.address.address, source: input.address.source },
    scopes: scopes.map((scope) => ({ key: scope.key, label: scope.label })),
    endpoints: serviceEndpoints(input.manifest).map((e) => ({ method: e.method, url: `${base}${e.path}`, scopeLabel: e.scopeLabel })),
    tokens,
  };
}
