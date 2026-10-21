import { createHmac } from "node:crypto";

/** The header value the channel checks: the same HMAC-SHA256 the shell checks on the webhook, over the exact body sent. */
export const signature = (secret: string, body: string): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
