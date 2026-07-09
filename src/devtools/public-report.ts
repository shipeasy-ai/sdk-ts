// Public bug intake — POST {edge}/cli/report, authenticated with the app's
// PUBLIC CLIENT KEY (no login required). Three server-side gates apply:
//   1. the key must carry the `tickets:public_create` scope,
//   2. the project must have opted in (Settings → allow_public_tickets — the
//      SDK surfaces this as `devtools.allow_public_tickets` on /sdk/evaluate),
//   3. the ticket is force-filed as `pending_approval` (human-reviewed).
// A 403 from either gate 1 or 2 rejects with `PublicTicketsDisabled` so the UI
// can show a friendly "not enabled for this project" instead of a raw error.

import { DEFAULT_EDGE_BASE_URL } from "./types";

/** The project has not opted into public ticket creation (or the client key
 *  lacks the `tickets:public_create` scope). */
export class PublicTicketsDisabled extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "PublicTicketsDisabled";
  }
}

export interface PublicBugInput {
  /** One-line summary (required, ≤200 chars). */
  title: string;
  /** What happened — the actual result / error text (≤8000 chars). */
  error?: string;
  /** Freeform description / steps (≤8000 chars). */
  description?: string;
  /** Optional contact email for follow-up. */
  reporterEmail?: string;
  /** Where in the app it happened — feeds the server-side dedupe key
   *  (same title + step dedupes to the existing open ticket). */
  step?: string;
  /** System/env info (platform, os version, app version, …). */
  context?: Record<string, unknown>;
}

export interface PublicBugResult {
  /** The filed (or deduped-to) ticket number. */
  number: number;
  /** True when an open ticket with the same title+step already existed. */
  deduped: boolean;
}

export interface SubmitPublicBugOptions {
  /** The app's public client key (`sdk_client_*`) — safe to embed. Must carry
   *  the `tickets:public_create` scope. */
  clientKey: string;
  /** Edge worker origin. Defaults to production (`https://api.shipeasy.ai`). */
  edgeBaseUrl?: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}

export async function submitPublicBug(
  input: PublicBugInput,
  opts: SubmitPublicBugOptions,
): Promise<PublicBugResult> {
  const edge = (opts.edgeBaseUrl ?? DEFAULT_EDGE_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  const res = await fetchImpl(`${edge}/cli/report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SDK-Key": opts.clientKey,
    },
    body: JSON.stringify({
      title: input.title,
      ...(input.error ? { error: input.error } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.reporterEmail ? { reporter_email: input.reporterEmail } : {}),
      ...(input.step ? { step: input.step } : {}),
      ...(input.context ? { context: input.context } : {}),
    }),
  });

  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PublicTicketsDisabled(
      body.error ?? "Public bug reporting is not enabled for this project.",
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Bug report failed (HTTP ${res.status}). Please try again.`);
  }

  const data = (await res.json()) as { number: number; deduped?: boolean };
  return { number: data.number, deduped: data.deduped === true };
}
