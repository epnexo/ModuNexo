"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Approve or reject one proposal. A refusal (not yours to decide, no longer waiting) is shown as it came, and nothing is changed. */
export function ProposalButtons({ id, canDecide }: { id: number; canDecide: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function decide(kind: "approve" | "reject") {
    setPending(kind);
    setError(null);
    try {
      const response = await fetch(`/api/actions/proposals/${id}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(kind === "reject" && note.trim() !== "" ? { note: note.trim() } : {}),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) router.refresh();
      else setError(data.error ?? "Could not decide it.");
    } catch {
      setError("Could not reach the server.");
    }
    setPending(null);
  }

  if (!canDecide) return <p className="text-sm text-muted">You do not hold the permission this action needs.</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={pending !== null} onClick={() => void decide("approve")} className="btn btn-primary btn-sm inline-flex items-center gap-2">
          {pending === "approve" ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
          Approve
        </button>
        <input aria-label={`Reason to reject proposal ${id} (optional)`} value={note} maxLength={300} onChange={(event) => setNote(event.target.value)} placeholder="Reason (optional)" className="input h-8 w-56 text-sm" />
        <button type="button" disabled={pending !== null} onClick={() => void decide("reject")} className="btn btn-sm inline-flex items-center gap-2">
          {pending === "reject" ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
          Reject
        </button>
      </div>
      {error === null ? null : (
        <p role="alert" data-guard className="notice notice-error text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
