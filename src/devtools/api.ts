// DevtoolsClient — the headless admin API client behind the devtools surfaces.
//
// A thin session wrapper over the GENERATED per-operation SDK
// (`./generated/sdk.gen`, from the vendored admin OpenAPI spec): every
// endpoint the spec covers is called through its generated function, so the
// request/response contract can't drift from the spec without a type error
// here. What stays hand-written is exactly what codegen can't know:
//   • the per-session bearer key + configurable admin origin,
//   • the memo cache + cursor-draining semantics the overlays rely on,
//   • 401 → `onUnauthed` (injected callback — no DOM event; React Native and
//     the browser overlay each adapt it),
//   • the overlays' narrowed record projections (see ./types.ts),
//   • the handful of endpoints not yet in the spec (marked SPEC GAP below).

import type {
  AttachmentUploadResult,
  BugDetail,
  BugRecord,
  ConfigRecord,
  DraftRecord,
  ExperimentRecord,
  FeatureRequestDetail,
  FeatureRequestRecord,
  GateRecord,
  KeyRecord,
  ProfileRecord,
  ProjectRecord,
  UniverseRecord,
} from "./types";
import { DEFAULT_ADMIN_BASE_URL, PERMISSIVE_CONFIG_SCHEMA } from "./types";
// Generated `z.infer` request shapes (@hey-api zod plugin). `createBug` /
// `createFeatureRequest` inject the `type` discriminator, so callers omit it.
import type { CreateBugRequestInput, CreateFeatureRequestRequestInput } from "./generated/zod.gen";
import type {
  CreateOpsItemRequest,
  UpdateOpsItemRequest,
} from "./generated/types.gen";
import { createClient, createConfig } from "./generated/client";
import type { Client } from "./generated/client";
import {
  createI18nDraft,
  createOpsItem,
  getConfig as getConfigOp,
  getOpsItem,
  listConfigs,
  listExperiments,
  listGates,
  listI18nDrafts,
  listI18nKeys,
  listI18nProfiles,
  listOpsItems,
  listUniverses,
  updateI18nKey,
  updateOpsItem,
} from "./generated/sdk.gen";

/** Thrown when an admin request returns 401. Distinct from generic `Error`
 *  so callers can branch on it without string-matching. */
export class AuthError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface DevtoolsClientOptions {
  /** Raw admin SDK key from device auth (`sdk_admin_*`). */
  token: string;
  projectId: string;
  /** Admin API origin. Defaults to production (`https://shipeasy.ai`). */
  adminBaseUrl?: string;
  /** Called once per 401 so the host can clear its stored session and
   *  re-prompt login. The request still rejects with `AuthError`. */
  onUnauthed?: () => void;
  /** Injectable fetch for tests / exotic runtimes. Defaults to global fetch.
   *  Note the generated client invokes it with a single `Request` argument. */
  fetch?: typeof fetch;
}

/** The `{ data, error, response }` triple every generated op resolves to
 *  (hey-api `responseStyle: "fields"`, `throwOnError: false`). */
interface OpResult<T> {
  data?: T;
  error?: unknown;
  response?: Response;
}

export class DevtoolsClient {
  // Per-instance memo cache keyed by method/args. List endpoints rarely change
  // between tab switches, so caching the promise lets users flip between
  // panels without refetching. Mutations scrub their own keys.
  private cache = new Map<string, Promise<unknown>>();
  private readonly adminBaseUrl: string;
  /** Raw admin bearer key for this session. Public so overlays can compare it
   *  against their stored session and rebuild the client on session swap. */
  readonly token: string;
  readonly projectId: string;
  private readonly onUnauthed?: () => void;
  private readonly fetchImpl: typeof fetch;
  /** Session-configured generated client — every spec-covered call goes
   *  through it (bearer auth, base URL, injectable fetch). */
  private readonly api: Client;

  constructor(opts: DevtoolsClientOptions) {
    this.adminBaseUrl = (opts.adminBaseUrl ?? DEFAULT_ADMIN_BASE_URL).replace(/\/$/, "");
    this.token = opts.token;
    this.projectId = opts.projectId;
    this.onUnauthed = opts.onUnauthed;
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
    this.api = createClient(
      createConfig({
        baseUrl: this.adminBaseUrl,
        // Generated ops declare `security: [{ scheme: "bearer" }]`; the client
        // resolves the token through this callback per request.
        auth: () => this.token,
        // Never send cookies: the client authenticates with its minted admin
        // SDK key, NOT the dashboard session. Dogfooded same-origin, a session
        // cookie would otherwise ride along and `authenticateAdmin` prefers
        // the session, resolving the WRONG project → 403. RN ignores this.
        credentials: "omit",
        fetch: opts.fetch,
        throwOnError: false,
      }),
    );
  }

  /** Admin origin this client talks to. Overlays build dashboard deep links
   *  ("Open in dashboard ↗") off it. */
  get adminUrl(): string {
    return this.adminBaseUrl;
  }

  /** Run `fn` once per `key` and cache the resulting promise. Rejections are
   *  evicted so the next call retries instead of replaying the failure. */
  private memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key) as Promise<T> | undefined;
    if (hit) return hit;
    const p = fn();
    this.cache.set(key, p);
    p.catch(() => {
      if (this.cache.get(key) === p) this.cache.delete(key);
    });
    return p;
  }

  /** Drop all cached responses (pull-to-refresh). */
  invalidate(): void {
    this.cache.clear();
  }

  /** Build + throw the error for a failed request. 401 produces an `AuthError`
   *  and fires `onUnauthed` so the host can drop the stale session instead of
   *  leaving the user staring at a failed-load message. */
  private fail(path: string, error: unknown, response?: Response): never {
    const status = response?.status ?? 0;
    let detail = "";
    if (error && typeof error === "object") {
      const e = error as { detail?: string; error?: string };
      detail = e.detail ?? e.error ?? "";
    } else if (typeof error === "string") {
      detail = error.slice(0, 200);
    }
    const message = `${path} → HTTP ${status}${detail ? ` — ${detail}` : ""}`;
    if (status === 401) {
      try {
        this.onUnauthed?.();
      } catch {
        // never let a host callback break the error path
      }
      throw new AuthError(message);
    }
    throw new Error(message);
  }

  /** Resolve a generated op result to its body, or throw the normalized
   *  error. Write ops with empty bodies pass on any 2xx. */
  private unwrap<T>(path: string, r: OpResult<T>): T {
    if (r.error !== undefined || (r.data === undefined && !(r.response?.ok ?? false))) {
      this.fail(path, r.error, r.response);
    }
    return r.data as T;
  }

  /** Some list endpoints return a bare array, others a `{ data }` envelope
   *  (the spec is the contract, but be tolerant like the overlays always
   *  were). */
  private asList<T>(body: unknown): T[] {
    return (Array.isArray(body) ? body : ((body as { data?: T[] }).data ?? [])) as T[];
  }

  /**
   * Drain a paginated `{ data, next_cursor }` list op by walking cursors.
   * Devtools shows the entire list at once; without this, large projects would
   * silently truncate at the first page (limit=100 default).
   */
  private async drain<TItem>(
    path: string,
    page: (query: {
      limit: number;
      cursor?: string;
    }) => Promise<OpResult<{ data: unknown[]; next_cursor?: string | null }>>,
    limit = 500,
  ): Promise<TItem[]> {
    const out: TItem[] = [];
    let cursor: string | undefined;
    do {
      const body = this.unwrap(path, await page({ limit, ...(cursor ? { cursor } : {}) }));
      // Tolerate a bare-array body like the pre-generated-client drainList did
      // (the spec is the contract, but stubbed/legacy endpoints return raw
      // arrays — a bare array is by definition the complete list).
      if (Array.isArray(body)) return body as TItem[];
      out.push(...(body.data as TItem[]));
      cursor = body.next_cursor ?? undefined;
    } while (cursor);
    return out;
  }

  // ── SPEC-GAP raw transport ──────────────────────────────────────────────
  // A few admin routes the overlays use aren't in the OpenAPI contract yet
  // (spec-alignment candidates). Until they land there, these two helpers
  // carry them with the same auth/error semantics as the generated client.

  private rawInit(extra?: RequestInit): RequestInit {
    return {
      credentials: "omit", // see the createConfig note above
      headers: { Authorization: `Bearer ${this.token}` },
      ...extra,
    };
  }

  private async rawGet<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.adminBaseUrl}${path}`, this.rawInit());
    if (!res.ok) this.fail(path, await this.readErrorDetail(res), res);
    const body = await res.json();
    return (Array.isArray(body) ? body : ((body as { data: T }).data ?? body)) as T;
  }

  private async rawSend<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(
      `${this.adminBaseUrl}${path}`,
      this.rawInit({
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) this.fail(path, await this.readErrorDetail(res), res);
    return (await res.json()) as T;
  }

  /** Read the response error body for diagnostics. Best-effort; never throws. */
  private async readErrorDetail(res: Response): Promise<unknown> {
    try {
      return (await res.json()) as unknown;
    } catch {
      try {
        return (await res.text()).slice(0, 200);
      } catch {
        return "";
      }
    }
  }

  // ── project ─────────────────────────────────────────────────────────────

  project(): Promise<ProjectRecord> {
    return this.memo("project", async () => {
      // SPEC GAP: `GET /api/admin/projects/{id}` isn't in the OpenAPI contract
      // (only /current, which resolves by key, and PATCH /{id}).
      const raw = await this.rawGet<{
        id: string;
        name: string;
        domain: string | null;
        moduleTranslations?: boolean | number;
        moduleConfigs?: boolean | number;
        moduleGates?: boolean | number;
        moduleExperiments?: boolean | number;
        moduleFeedback?: boolean | number;
        moduleUser?: boolean | number;
        moduleEvents?: boolean | number;
      }>(`/api/admin/projects/${encodeURIComponent(this.projectId)}`);
      const b = (v: boolean | number | undefined): boolean =>
        v === undefined || v === true || v === 1;
      return {
        id: raw.id,
        name: raw.name,
        domain: raw.domain,
        modules: {
          translations: b(raw.moduleTranslations),
          configs: b(raw.moduleConfigs),
          gates: b(raw.moduleGates),
          experiments: b(raw.moduleExperiments),
          feedback: b(raw.moduleFeedback),
          user: b(raw.moduleUser),
          events: b(raw.moduleEvents),
        },
      };
    });
  }

  // ── release surface ─────────────────────────────────────────────────────

  gates(): Promise<GateRecord[]> {
    return this.memo("gates", () =>
      // The wire returns more fields than the generated list item declares
      // (killswitch, rolloutPct — spec-alignment candidates); the projection
      // widens to the overlay contract.
      this.drain<GateRecord>("/api/admin/gates", (query) =>
        listGates({ client: this.api, query }),
      ),
    );
  }

  configs(): Promise<ConfigRecord[]> {
    return this.memo("configs", async () => {
      // The list endpoint sheds `valueJson` (per-env), so fetch each config's
      // detail and project the active env's value back into `valueJson`.
      const list = await this.drain<{
        id: string;
        name: string;
        updatedAt: string;
        schema?: Record<string, unknown>;
      }>("/api/admin/configs", (query) => listConfigs({ client: this.api, query }));
      const env = "prod";
      return Promise.all(
        list.map(async (c) => {
          try {
            const detail = this.unwrap(
              `/api/admin/configs/${c.id}`,
              await getConfigOp({ client: this.api, path: { id: c.id } }),
            ) as {
              values?: Record<string, unknown>;
              valueJson?: unknown;
              schema?: Record<string, unknown>;
            };
            const valueJson =
              detail.valueJson !== undefined ? detail.valueJson : (detail.values?.[env] ?? {});
            return {
              id: c.id,
              name: c.name,
              updatedAt: c.updatedAt,
              valueJson,
              schema: detail.schema ?? c.schema ?? PERMISSIVE_CONFIG_SCHEMA,
            } as ConfigRecord;
          } catch {
            return {
              id: c.id,
              name: c.name,
              updatedAt: c.updatedAt,
              valueJson: {},
              schema: c.schema ?? PERMISSIVE_CONFIG_SCHEMA,
            } as ConfigRecord;
          }
        }),
      );
    });
  }

  /** Experiments list. The endpoint returns the non-archived set (running /
   *  draft / stopped) by default; pass `{ archived: true }` for the archive tab
   *  (a separate memo bucket so the overlay's Archived section loads on demand). */
  experiments(opts?: { archived?: boolean }): Promise<ExperimentRecord[]> {
    const archived = opts?.archived === true;
    return this.memo(archived ? "experiments:archived" : "experiments", () =>
      this.drain<ExperimentRecord>("/api/admin/experiments", (query) =>
        listExperiments({
          client: this.api,
          query: archived ? { ...query, status: "archived" } : query,
        }),
      ),
    );
  }

  universes(): Promise<UniverseRecord[]> {
    return this.memo("universes", () =>
      this.drain<UniverseRecord>("/api/admin/universes", (query) =>
        listUniverses({ client: this.api, query }),
      ),
    );
  }

  // ── i18n ────────────────────────────────────────────────────────────────

  profiles(): Promise<ProfileRecord[]> {
    return this.memo("profiles", async () =>
      this.asList<ProfileRecord>(
        this.unwrap("/api/admin/i18n/profiles", await listI18nProfiles({ client: this.api })),
      ),
    );
  }

  drafts(): Promise<DraftRecord[]> {
    return this.memo("drafts", async () =>
      this.asList<DraftRecord>(
        this.unwrap("/api/admin/i18n/drafts", await listI18nDrafts({ client: this.api })),
      ),
    );
  }

  keys(profileId?: string): Promise<KeyRecord[]> {
    return this.memo(`keys:${profileId ?? ""}`, async () => {
      // The admin endpoint paginates with a default page size of 200. The
      // devtools panels need *every* key for the project (the tree/list is
      // rendered client-side), so page through using the `total` from the
      // first response instead of relying on the backend's default cap.
      const PAGE = 500;
      const fetchPage = async (offset: number): Promise<{ keys: KeyRecord[]; total: number }> => {
        const body = this.unwrap(
          "/api/admin/i18n/keys",
          await listI18nKeys({
            client: this.api,
            query: {
              ...(profileId ? { profile_id: profileId } : {}),
              limit: PAGE,
              offset,
            },
          }),
        ) as unknown;
        if (Array.isArray(body)) return { keys: body as KeyRecord[], total: body.length };
        const keys = ((body as { keys?: KeyRecord[] }).keys ?? []) as KeyRecord[];
        const total = (body as { total?: number }).total ?? keys.length;
        return { keys, total };
      };

      const first = await fetchPage(0);
      const all = first.keys.slice();
      while (all.length < first.total && first.keys.length > 0) {
        const next = await fetchPage(all.length);
        if (next.keys.length === 0) break;
        all.push(...next.keys);
      }
      return all;
    });
  }

  async createDraft(input: { profileId: string; name: string }): Promise<DraftRecord> {
    const r = this.unwrap(
      "/api/admin/i18n/drafts",
      await createI18nDraft({
        client: this.api,
        body: { profile_id: input.profileId, name: input.name },
      }),
    ) as unknown as DraftRecord;
    this.cache.delete("drafts");
    return r;
  }

  async upsertDraftKey(draftId: string, key: string, value: string): Promise<void> {
    // SPEC GAP: `POST /api/admin/i18n/drafts/{id}/keys` isn't in the contract.
    await this.rawSend("POST", `/api/admin/i18n/drafts/${encodeURIComponent(draftId)}/keys`, {
      key,
      value,
    });
    this.invalidateKeysCache();
  }

  async updateKeyById(id: string, value: string): Promise<void> {
    this.unwrap(
      `/api/admin/i18n/keys/${id}`,
      await updateI18nKey({ client: this.api, path: { id }, body: { value } }),
    );
    this.invalidateKeysCache();
  }

  async upsertKeys(
    profileId: string,
    keys: Array<{ key: string; value: string }>,
    chunk = "default",
  ): Promise<void> {
    // SPEC GAP: `PUT /api/admin/i18n/keys` (bulk OVERWRITE) isn't in the
    // contract — the spec'd POST (`pushI18nKeys`) is insert-only and would
    // silently skip the labels being edited here.
    await this.rawSend("PUT", `/api/admin/i18n/keys`, { profile_id: profileId, chunk, keys });
    this.invalidateKeysCache();
  }

  /** Drop every cached `keys(profileId?)` response. We don't track which
   *  profile a single key write affects, so be safe and clear them all. */
  private invalidateKeysCache(): void {
    for (const k of Array.from(this.cache.keys())) {
      if (k.startsWith("keys:")) this.cache.delete(k);
    }
  }

  // ── feedback (bugs + feature requests) ──────────────────────────────────

  bugs(): Promise<BugRecord[]> {
    return this.memo("bugs", async () =>
      this.asList<BugRecord>(
        this.unwrap(
          "/api/admin/ops?type=bug",
          await listOpsItems({ client: this.api, query: { type: "bug" } }),
        ),
      ),
    );
  }

  bug(id: string): Promise<BugDetail> {
    return this.memo(`bug:${id}`, async () =>
      this.unwrap(
        `/api/admin/ops/${id}`,
        await getOpsItem({ client: this.api, path: { handle: id } }),
      ) as unknown as BugDetail,
    );
  }

  async createBug(input: Omit<CreateBugRequestInput, "type">): Promise<{ id: string }> {
    const r = this.unwrap(
      "/api/admin/ops",
      await createOpsItem({
        client: this.api,
        body: { ...input, type: "bug" } as CreateOpsItemRequest,
      }),
    );
    this.cache.delete("bugs");
    return r as { id: string };
  }

  async updateBug(
    id: string,
    patch: {
      title?: string;
      stepsToReproduce?: string;
      actualResult?: string;
      expectedResult?: string;
      status?: BugRecord["status"];
      priority?: BugRecord["priority"];
    },
  ): Promise<void> {
    this.unwrap(
      `/api/admin/ops/${id}`,
      await updateOpsItem({
        client: this.api,
        path: { handle: id },
        body: patch as UpdateOpsItemRequest,
      }),
    );
    this.cache.delete("bugs");
    this.cache.delete(`bug:${id}`);
  }

  featureRequests(): Promise<FeatureRequestRecord[]> {
    return this.memo("featureRequests", async () =>
      this.asList<FeatureRequestRecord>(
        this.unwrap(
          "/api/admin/ops?type=feature_request",
          await listOpsItems({ client: this.api, query: { type: "feature_request" } }),
        ),
      ),
    );
  }

  featureRequest(id: string): Promise<FeatureRequestDetail> {
    return this.memo(`featureRequest:${id}`, async () =>
      this.unwrap(
        `/api/admin/ops/${id}`,
        await getOpsItem({ client: this.api, path: { handle: id } }),
      ) as unknown as FeatureRequestDetail,
    );
  }

  async createFeatureRequest(
    input: Omit<CreateFeatureRequestRequestInput, "type">,
  ): Promise<{ id: string }> {
    const r = this.unwrap(
      "/api/admin/ops",
      await createOpsItem({
        client: this.api,
        body: { ...input, type: "feature_request" } as CreateOpsItemRequest,
      }),
    );
    this.cache.delete("featureRequests");
    return r as { id: string };
  }

  async updateFeatureRequest(
    id: string,
    patch: {
      title?: string;
      description?: string;
      useCase?: string;
      status?: FeatureRequestRecord["status"];
      priority?: FeatureRequestRecord["priority"];
    },
  ): Promise<void> {
    this.unwrap(
      `/api/admin/ops/${id}`,
      await updateOpsItem({
        client: this.api,
        path: { handle: id },
        body: patch as UpdateOpsItemRequest,
      }),
    );
    this.cache.delete("featureRequests");
    this.cache.delete(`featureRequest:${id}`);
  }

  // ── attachments ─────────────────────────────────────────────────────────
  // SPEC GAP: the report-attachment routes aren't in the OpenAPI contract.

  /** Fetch an attachment file as a Blob via the authenticated stream route
   *  (an <Image>/<img> can't send the Authorization header itself). */
  async attachmentBlob(id: string): Promise<Blob> {
    const path = `/api/admin/reports/attachments/${encodeURIComponent(id)}`;
    const res = await this.fetchImpl(`${this.adminBaseUrl}${path}`, this.rawInit());
    if (!res.ok) this.fail(path, await this.readErrorDetail(res), res);
    return res.blob();
  }

  async uploadAttachment(args: {
    reportKind: "bug" | "feature_request";
    reportId: string;
    kind: "screenshot" | "recording" | "file";
    filename: string;
    blob: Blob;
  }): Promise<AttachmentUploadResult> {
    const fd = new FormData();
    fd.append("reportKind", args.reportKind);
    fd.append("reportId", args.reportId);
    fd.append("kind", args.kind);
    fd.append("filename", args.filename);
    // DOM FormData takes (name, blob, filename); react-native's TYPES declare a
    // 2-arg append even though its runtime accepts the filename too. Call
    // through a 3-arg view so both type-check programs accept it.
    (fd.append as (name: string, value: Blob, fileName?: string) => void)(
      "file",
      args.blob,
      args.filename,
    );
    const path = "/api/admin/reports/attachments";
    const res = await this.fetchImpl(
      `${this.adminBaseUrl}${path}`,
      this.rawInit({ method: "POST", body: fd }),
    );
    if (!res.ok) this.fail(path, await this.readErrorDetail(res), res);
    return (await res.json()) as AttachmentUploadResult;
  }
}
