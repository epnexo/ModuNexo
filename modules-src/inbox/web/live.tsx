"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Refreshes the page when a message arrives. The stream resumes by cursor on its own; a `reset` means events were missed. */
export function Live() {
  const router = useRouter();
  useEffect(() => {
    const stream = new EventSource("/api/events?types=inbox.message.received");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 250);
    };
    stream.addEventListener("inbox.message.received", refresh);
    stream.addEventListener("reset", refresh);
    return () => {
      clearTimeout(timer);
      stream.close();
    };
  }, [router]);
  return null;
}
