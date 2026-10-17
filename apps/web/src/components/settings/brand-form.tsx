"use client";

import { LoaderCircle, Trash2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import type { BrandProfile } from "@epnexo/core/brand";
import { BrandMark } from "../brand/brand-mark";

const MAX_BYTES = 512 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp"];

interface Fields {
  kind: "business" | "personal" | null;
  name: string;
  representative: string;
  email: string;
  website: string;
  phone: string;
  taxId: string;
  address: string;
  monogramHue: number;
}

function fieldsOf(profile: BrandProfile | null): Fields {
  const empty: Fields = { kind: null, name: "", representative: "", email: "", website: "", phone: "", taxId: "", address: "", monogramHue: 250 };
  if (profile === null) return empty;
  if (profile.kind === "personal") return { ...empty, kind: "personal", name: profile.name, monogramHue: profile.monogramHue };
  return { ...empty, kind: "business", name: profile.name, representative: profile.representative, email: profile.email, website: profile.website ?? "", phone: profile.phone ?? "", taxId: profile.taxId ?? "", address: profile.address ?? "" };
}

function profileOf(values: Fields): Record<string, unknown> {
  if (values.kind === "personal") return { kind: "personal", name: values.name, monogramHue: values.monogramHue };
  return { kind: "business", name: values.name, representative: values.representative, email: values.email, website: values.website, phone: values.phone, taxId: values.taxId, address: values.address };
}

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const field = "h-10 rounded-md border border-border-strong bg-surface px-3 outline-none transition-colors duration-150 focus-visible:border-accent disabled:opacity-60";

export function BrandForm({ initial, logo, canWrite }: { initial: BrandProfile | null; logo: string | null; canWrite: boolean }) {
  const router = useRouter();
  const [values, setValues] = useState(() => fieldsOf(initial));
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [picking, setPicking] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string; bytes: number } | null>(null);
  const [hasLogo, setHasLogo] = useState(logo !== null);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = pending || uploading;
  const set = (patch: Partial<Fields>) => setValues((current) => ({ ...current, ...patch }));

  async function request(url: string, method: string, body?: BodyInit, headers?: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await fetch(url, { method, ...(body === undefined ? {} : { body }), ...(headers === undefined ? {} : { headers }) });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      return response.ok ? { ok: true } : { ok: false, error: data.error ?? "The change was refused." };
    } catch {
      return { ok: false, error: "Could not reach the server." };
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (values.kind === null) return;
    setPending(true);
    setStatus(null);
    const result = await request("/api/settings/brand", "PUT", JSON.stringify(profileOf(values)), { "content-type": "application/json" });
    setStatus(result.ok ? { kind: "ok", text: "Saved." } : { kind: "error", text: result.error ?? "Could not save." });
    if (result.ok) router.refresh();
    setPending(false);
  }

  async function chosen(file: File | undefined) {
    setPicking(false);
    if (file === undefined) return;
    if (!TYPES.includes(file.type)) return setStatus({ kind: "error", text: "Choose a PNG, JPEG or WebP image." });
    if (file.size > MAX_BYTES) return setStatus({ kind: "error", text: `That image is ${size(file.size)}; the limit is 512 KB.` });
    if (preview !== null) URL.revokeObjectURL(preview.url);
    setPreview({ url: URL.createObjectURL(file), name: file.name, bytes: file.size });
    setUploading(true);
    setStatus(null);
    const result = await request("/api/brand/logo", "PUT", file);
    if (result.ok) {
      setHasLogo(true);
      setStatus({ kind: "ok", text: "Image uploaded." });
      router.refresh();
    } else {
      setPreview(null);
      setStatus({ kind: "error", text: result.error ?? "The image could not be uploaded." });
    }
    setUploading(false);
  }

  async function removeLogo() {
    setUploading(true);
    const result = await request("/api/brand/logo", "DELETE");
    if (result.ok) {
      setHasLogo(false);
      setPreview(null);
      setStatus({ kind: "ok", text: "Image removed." });
      router.refresh();
    } else setStatus({ kind: "error", text: result.error ?? "The image could not be removed." });
    setUploading(false);
  }

  const business = values.kind === "business";
  const imageLabel = business ? "Logo" : "Photo (optional)";
  const live: BrandProfile | null =
    values.kind === null || values.name.trim() === ""
      ? null
      : values.kind === "personal"
        ? { kind: "personal", name: values.name, monogramHue: values.monogramHue }
        : { kind: "business", name: values.name, representative: values.representative, email: values.email };

  const text = (id: keyof Fields, label: string, options: { required?: boolean; type?: string; placeholder?: string; hint?: string } = {}) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`brand-${id}`} className="text-sm font-medium">
        {label}
        {options.required ? <span className="text-danger"> *</span> : null}
      </label>
      <input
        id={`brand-${id}`}
        type={options.type ?? "text"}
        value={values[id] as string}
        required={options.required}
        disabled={!canWrite || busy}
        placeholder={options.placeholder}
        onChange={(event) => set({ [id]: event.target.value } as Partial<Fields>)}
        className={`${field} max-w-xl`}
      />
      {options.hint ? <p className="text-sm text-muted">{options.hint}</p> : null}
    </div>
  );

  return (
    <form onSubmit={save} className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-2" disabled={!canWrite || busy}>
        <legend className="mb-1.5 text-sm font-medium">This platform is for</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ["business", "A business", "Shows your logo, name and contact details across the platform."],
              ["personal", "A person", "A simple, friendly identity: a name and an optional photo."],
            ] as const
          ).map(([kind, title, hint]) => (
            <label
              key={kind}
              className={"flex cursor-pointer flex-col gap-1 rounded-lg border p-4 transition-colors duration-150 " + (values.kind === kind ? "border-accent bg-accent-soft text-accent-soft-foreground" : "border-border-strong hover:bg-panel-hover")}
            >
              <span className="flex items-center gap-2 font-medium">
                <input type="radio" name="brand-kind" value={kind} checked={values.kind === kind} onChange={() => set({ kind })} className="accent-(--accent)" />
                {title}
              </span>
              <span className="text-sm text-muted">{hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {values.kind === null ? null : (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{imageLabel}</span>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-label={imageLabel} onChange={(event) => void chosen(event.target.files?.[0])} />
            <div className="flex max-w-xl items-center gap-4 rounded-md border border-dashed border-border-strong bg-surface p-3" aria-live="polite">
              <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-background">
                {picking || uploading ? (
                  <LoaderCircle aria-hidden className="size-5 animate-spin text-muted motion-reduce:animate-none" />
                ) : preview !== null ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a local preview of the chosen file
                  <img src={preview.url} alt="" className="size-full object-contain" />
                ) : (
                  <BrandMark profile={live ?? { kind: "personal", name: "?", monogramHue: values.monogramHue }} logo={hasLogo ? logo : null} size={64} showName={false} />
                )}
              </span>
              <div className="min-w-0 flex-1 text-sm">
                {picking ? (
                  <span className="text-muted">Waiting for the file dialog&hellip;</span>
                ) : uploading ? (
                  <span className="text-muted">Uploading{preview ? ` ${preview.name}` : ""}&hellip;</span>
                ) : preview !== null ? (
                  <>
                    <span className="block truncate font-medium">{preview.name}</span>
                    <span className="text-muted">{size(preview.bytes)}</span>
                  </>
                ) : hasLogo ? (
                  <span className="text-muted">Image in use</span>
                ) : (
                  <span className="text-muted">PNG, JPEG or WebP, up to 512 KB{business ? "" : "; without one, a monogram is generated"}</span>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={!canWrite || busy || picking}
                  onClick={() => {
                    setPicking(true);
                    fileInput.current?.click();
                    window.addEventListener("focus", () => setTimeout(() => setPicking(false), 400), { once: true });
                  }}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-border-strong px-3 text-sm transition-colors duration-150 hover:bg-panel-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Upload aria-hidden className="size-4" />
                  {hasLogo ? "Replace" : "Upload"}
                </button>
                {hasLogo ? (
                  <button type="button" disabled={!canWrite || busy} onClick={() => void removeLogo()} aria-label="Remove the image" className="inline-flex h-9 items-center rounded-md border border-border-strong px-2.5 text-danger transition-colors duration-150 hover:bg-panel-hover disabled:cursor-not-allowed disabled:opacity-60">
                    <Trash2 aria-hidden className="size-4" />
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          {text("name", business ? "Business name" : "Your name", { required: true })}

          {business ? (
            <>
              {text("representative", "Legal representative", { required: true })}
              {text("email", "Contact email", { required: true, type: "email" })}
              {text("website", "Website", { type: "url", placeholder: "https://example.com" })}
              {text("phone", "Phone")}
              {text("taxId", "Tax id", { hint: "NIT, RUC, VAT or the number your country uses." })}
              {text("address", "Address")}
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="brand-hue" className="text-sm font-medium">
                Monogram color
              </label>
              <div className="flex max-w-md items-center gap-3">
                <input id="brand-hue" type="range" min={0} max={360} step={1} value={values.monogramHue} disabled={!canWrite || busy} onChange={(event) => set({ monogramHue: Number(event.target.value) })} className="flex-1 accent-(--accent)" />
                <BrandMark profile={{ kind: "personal", name: values.name.trim() === "" ? "?" : values.name, monogramHue: values.monogramHue }} logo={null} size={40} showName={false} />
              </div>
              <p className="text-sm text-muted">Used when there is no photo.</p>
            </div>
          )}
        </>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!canWrite || busy || values.kind === null}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent px-4 font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-70"
        >
          {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
          Save profile
        </button>
        <p role="status" className={`text-sm ${status?.kind === "error" ? "text-danger" : "text-muted"}`}>
          {status?.text ?? (canWrite ? "" : "Only an administrator can change this.")}
        </p>
      </div>
    </form>
  );
}
