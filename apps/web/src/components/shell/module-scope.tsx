"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { type ModuleScope as Scope, moduleForPath } from "../../server/module-scope";

/**
 * Marks the content area with the module whose pages are showing, so that module's appearance overrides (written
 * under `[data-module="<id>"]`) apply to it and to nothing else. It re-evaluates on every navigation.
 */
export function ModuleScope({ scopes, children }: { scopes: Scope[]; children: ReactNode }) {
  const moduleId = moduleForPath(usePathname(), scopes);
  return <div data-module={moduleId ?? undefined}>{children}</div>;
}
