// Public ticket intake — POST {edge}/cli/report, authenticated with the app's
// PUBLIC CLIENT KEY (no login required). Files bugs and feature requests.
// Three server-side gates apply:
//   1. the key must carry the `tickets:public_create` scope,
//   2. the project must have opted in (Settings → allow_public_tickets — the
//      SDK surfaces this as `devtools.allow_public_tickets` on /sdk/evaluate),
//   3. the ticket is force-filed as `pending_approval` (human-reviewed).
// A 403 from either gate 1 or 2 rejects with `PublicTicketsDisabled` so the UI
// can show a friendly "not enabled for this project" instead of a raw error.
//
// Identity rides along automatically: the configured `@shipeasy/sdk/client`
// singleton's identified user (whatever the app passed to `identify()`, or the
// server-adopted `data-user`) is attached as `user`, read through the engine
// bridge — no extra call for the app to make. Shipeasy then snapshots the flags,
// kill switches and experiments that user had on onto the ticket. Pass `user`
// explicitly to override, or `null` to file without it.

import { DEFAULT_EDGE_BASE_URL, readEngineBridge } from "./types";

/** The reporter's SDK user attributes, as passed to `identify()`. */
export type ReporterUser = Record<string, unknown>;

/** `input.user` when the caller set it (incl. `null` = opt out), else the
 *  configured client SDK's identified user, else nothing. */
function reporterUser(explicit: ReporterUser | null | undefined): ReporterUser | null {
  if (explicit !== undefined) return explicit;
  try {
    const user = readEngineBridge()?.getUser();
    return user && Object.keys(user).length > 0 ? (user as ReporterUser) : null;
  } catch {
    return null;
  }
}

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
  /** Tag names to label the ticket with (≤50, each ≤64 chars). Each is matched
   *  case-insensitively against the project's existing tags — reused when it
   *  matches, created when it doesn't. */
  tags?: string[];
  /** The reporter's SDK identity. Defaults to the configured client SDK's
   *  identified user (via the engine bridge); pass `null` to file without one.
   *  Shipeasy snapshots the flags / kill switches / experiments this user had
   *  on onto the ticket. */
  user?: ReporterUser | null;
}

export interface PublicBugResult {
  /** The filed (or deduped-to) ticket number. */
  number: number;
  /** True when an open ticket with the same title+step already existed. */
  deduped: boolean;
}

export interface PublicFeatureInput {
  /** One-line summary (required, ≤200 chars). */
  title: string;
  /** What the feature should do (≤8000 chars). */
  description?: string;
  /** The workflow it would unblock (≤8000 chars). */
  useCase?: string;
  /** Optional contact email for follow-up. */
  reporterEmail?: string;
  /** Where in the app the request came from — feeds the server-side dedupe key. */
  step?: string;
  /** System/env info (platform, os version, app version, …). */
  context?: Record<string, unknown>;
  /** Tag names to label the ticket with (≤50, each ≤64 chars). Each is matched
   *  case-insensitively against the project's existing tags — reused when it
   *  matches, created when it doesn't. */
  tags?: string[];
  /** The reporter's SDK identity. Defaults to the configured client SDK's
   *  identified user (via the engine bridge); pass `null` to file without one.
   *  Shipeasy snapshots the flags / kill switches / experiments this user had
   *  on onto the ticket. */
  user?: ReporterUser | null;
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

async function postPublicReport(
  body: Record<string, unknown>,
  opts: SubmitPublicBugOptions,
  noun: string,
): Promise<PublicBugResult> {
  const edge = (opts.edgeBaseUrl ?? DEFAULT_EDGE_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  const res = await fetchImpl(`${edge}/cli/report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SDK-Key": opts.clientKey,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 403) {
    const resBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PublicTicketsDisabled(
      resBody.error ?? "Public reporting is not enabled for this project.",
    );
  }
  if (!res.ok) {
    const resBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(resBody.error ?? `${noun} failed (HTTP ${res.status}). Please try again.`);
  }

  const data = (await res.json()) as { number: number; deduped?: boolean };
  return { number: data.number, deduped: data.deduped === true };
}

function withUser(explicit: ReporterUser | null | undefined): { user?: ReporterUser } {
  const user = reporterUser(explicit);
  return user ? { user } : {};
}

export async function submitPublicBug(
  input: PublicBugInput,
  opts: SubmitPublicBugOptions,
): Promise<PublicBugResult> {
  return postPublicReport(
    {
      title: input.title,
      ...(input.error ? { error: input.error } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.reporterEmail ? { reporter_email: input.reporterEmail } : {}),
      ...(input.step ? { step: input.step } : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...withUser(input.user),
    },
    opts,
    "Bug report",
  );
}

/** File a feature request through the same public intake (`type: "feature"`).
 *  Same key/opt-in gates, same forced `pending_approval` state. */
export async function submitPublicFeature(
  input: PublicFeatureInput,
  opts: SubmitPublicBugOptions,
): Promise<PublicBugResult> {
  return postPublicReport(
    {
      type: "feature",
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.useCase ? { use_case: input.useCase } : {}),
      ...(input.reporterEmail ? { reporter_email: input.reporterEmail } : {}),
      ...(input.step ? { step: input.step } : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...withUser(input.user),
    },
    opts,
    "Feature request",
  );
}
