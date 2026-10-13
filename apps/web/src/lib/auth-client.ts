"use client";

import { createAuthClient } from "better-auth/react";

/** Same-origin client: it calls this app's own /api/auth endpoints. */
export const authClient = createAuthClient();
