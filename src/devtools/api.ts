// DevtoolsClient — the headless admin API client behind the devtools surfaces.
// Framework-agnostic port of the web overlay's `DevtoolsApi`: same endpoints,
// same memo-cache semantics, but no DOM — the 401 signal is an injected
// `onUnauthed` callback instead of a `window` CustomEvent, so React Native (or
// any host) can drop its stored session and reopen the login screen.

import type {
  AttachmentUploadResult,
  BugDetail,
  BugRecord,
  ConfigRecord,
  ExperimentRecord,
  FeatureRequestDetail,
  FeatureRequestRecord,
  GateRecord,
  ProjectRecord,
} from "./types";
import { DEFAULT_ADMIN_BASE_URL, PERMISSIVE_CONFIG_SCHEMA } from "./types";
// Generated `z.infer` request shapes (@hey-api zod plugin). `createBug` /
// `createFeatureRequest` inject the `type` discriminator, so callers omit it.
import type { CreateBugRequestInput, CreateFeatureRequestRequestInput } from "./generated/zod.gen";

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
  /** Injectable fetch for tests / exotic runtimes. Defaults to global fetch. */
  fetch?: typeof fetch;
}

export class DevtoolsClient {
  // Per-instance memo cache keyed by method/args. List endpoints rarely change
  // between tab switches, so caching the promise lets users flip between
  // panels without refetching. Mutations scrub their own keys.
  private cache = new Map<string, Promise<unknown>>();
  private readonly adminBaseUrl: string;
  private readonly token: string;
  readonly projectId: string;
  private readonly onUnauthed?: () => void;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DevtoolsClientOptions) {
    this.adminBaseUrl = (opts.adminBaseUrl ?? DEFAULT_ADMIN_BASE_URL).replace(/\/$/, "");
    this.token = opts.token;
    this.projectId = opts.projectId;
    this.onUnauthed = opts.onUnauthed;
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
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

  /** Read the response error body for diagnostics. Best-effort; never throws. */
  private async readErrorDetail(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      return body.detail ?? body.error ?? "";
    } catch {
      try {
        return (await res.text()).slice(0, 200);
      } catch {
        return "";
      }
    }
  }

  /** Build the error to throw for a non-2xx admin response. 401 produces an
   *  `AuthError` and fires `onUnauthed` so the host can drop the stale session
   *  instead of leaving the user staring at a failed-load message. */
  private async errorForResponse(path: string, res: Response): Promise<Error> {
    const detail = await this.readErrorDetail(res);
    const message = `${path} → HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
    if (res.status === 401) {
      try {
        this.onUnauthed?.();
      } catch {
        // never let a host callback break the error path
      }
      return new AuthError(message);
    }
    return new Error(message);
  }

  private headers(json = false): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.adminBaseUrl}${path}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw await this.errorForResponse(path, res);
    const body = await res.json();
    return (Array.isArray(body) ? body : ((body as { data: T }).data ?? body)) as T;
  }

  private async send<T>(method: "POST" | "PATCH", path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.adminBaseUrl}${path}`, {
      method,
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.errorForResponse(path, res);
    return (await res.json()) as T;
  }

  /**
   * Drain a paginated `{ data, next_cursor }` list endpoint by walking cursors.
   * Devtools shows the entire list at once; without this, large projects would
   * silently truncate at the first page (limit=100 default).
   */
  private async drainList<T>(basePath: string): Promise<T[]> {
    const sep = basePath.includes("?") ? "&" : "?";
    const out: T[] = [];
    let cursor: string | null = null;
    do {
      const q = `${sep}limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await this.fetchImpl(`${this.adminBaseUrl}${basePath}${q}`, {
        headers: this.headers(),
      });
      if (!res.ok) throw await this.errorForResponse(basePath, res);
      const body = (await res.json()) as T[] | { data: T[]; next_cursor: string | null };
      if (Array.isArray(body)) return body;
      out.push(...body.data);
      cursor = body.next_cursor;
    } while (cursor);
    return out;
  }

  project(): Promise<ProjectRecord> {
    return this.memo("project", async () => {
      const raw = await this.get<{
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

  gates(): Promise<GateRecord[]> {
    return this.memo("gates", () => this.drainList<GateRecord>("/api/admin/gates"));
  }

  configs(): Promise<ConfigRecord[]> {
    return this.memo("configs", async () => {
      // The list endpoint sheds `valueJson` (per-env), so fetch each config's
      // detail and project the active env's value back into `valueJson`.
      const list = await this.drainList<{
        id: string;
        name: string;
        updatedAt: string;
        schema?: Record<string, unknown>;
      }>("/api/admin/configs");
      const env = "prod";
      return Promise.all(
        list.map(async (c) => {
          try {
            const detail = await this.get<{
              values?: Record<string, unknown>;
              valueJson?: unknown;
              schema?: Record<string, unknown>;
            }>(`/api/admin/configs/${c.id}`);
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

  experiments(): Promise<ExperimentRecord[]> {
    return this.memo("experiments", () =>
      this.drainList<ExperimentRecord>("/api/admin/experiments"),
    );
  }

  bugs(): Promise<BugRecord[]> {
    return this.memo("bugs", () => this.get("/api/admin/ops?type=bug"));
  }

  bug(id: string): Promise<BugDetail> {
    return this.memo(`bug:${id}`, () => this.get(`/api/admin/ops/${encodeURIComponent(id)}`));
  }

  async createBug(input: Omit<CreateBugRequestInput, "type">): Promise<{ id: string }> {
    const r = await this.send<{ id: string }>("POST", "/api/admin/ops", {
      ...input,
      type: "bug",
    });
    this.cache.delete("bugs");
    return r;
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
    await this.send("PATCH", `/api/admin/ops/${encodeURIComponent(id)}`, patch);
    this.cache.delete("bugs");
    this.cache.delete(`bug:${id}`);
  }

  featureRequests(): Promise<FeatureRequestRecord[]> {
    return this.memo("featureRequests", () => this.get("/api/admin/ops?type=feature_request"));
  }

  featureRequest(id: string): Promise<FeatureRequestDetail> {
    return this.memo(`featureRequest:${id}`, () =>
      this.get(`/api/admin/ops/${encodeURIComponent(id)}`),
    );
  }

  async createFeatureRequest(
    input: Omit<CreateFeatureRequestRequestInput, "type">,
  ): Promise<{ id: string }> {
    const r = await this.send<{ id: string }>("POST", "/api/admin/ops", {
      ...input,
      type: "feature_request",
    });
    this.cache.delete("featureRequests");
    return r;
  }

  /** Fetch an attachment file as a Blob via the authenticated stream route
   *  (an <Image>/<img> can't send the Authorization header itself). */
  async attachmentBlob(id: string): Promise<Blob> {
    const path = `/api/admin/reports/attachments/${encodeURIComponent(id)}`;
    const res = await this.fetchImpl(`${this.adminBaseUrl}${path}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw await this.errorForResponse(path, res);
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
    const res = await this.fetchImpl(`${this.adminBaseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: fd,
    });
    if (!res.ok) throw await this.errorForResponse(path, res);
    return (await res.json()) as AttachmentUploadResult;
  }
}
