// see — shipeasy error. Structured error reporting shared by the server and
// client entrypoints. Side-agnostic: this module builds + sanitizes the wire
// event; each entrypoint owns its own transport (beacon vs fetch).
//
//   see(problem, causesThe("checkout").to("use cached prices"), { order_id });
//
// Philosophy (inherited from structured error loggers like Meta's opes): every
// handled exception documents its impact. If you don't know the consequence,
// don't catch the exception.

// ---- Limits ----
// Mirrored server-side in the worker's /collect handler — keep in sync.
export const SEE_MAX_MESSAGE = 500;
export const SEE_MAX_STACK = 8000;
export const SEE_MAX_SUBJECT = 200;
export const SEE_MAX_EXTRA_VALUE = 200;
export const SEE_MAX_EXTRA_KEYS = 20;
/** Correlation token length cap — bounds the join keyspace. Mirrored server-side. */
export const SEE_MAX_CORRELATION = 64;
export const SEE_DEDUP_WINDOW_MS = 30_000;
export const SEE_MAX_PER_SESSION = 25;

// ---- Types ----

export type SeeExtras = Record<string, string | number | boolean | null | undefined>;

export type SeeKind = "caught" | "uncaught" | "unhandled_rejection" | "network" | "violation";

/** Built by `causesThe(subject).to(outcome)` — never constructed by hand. */
export interface Consequence {
  readonly __seConsequence: true;
  readonly subject: string;
  readonly outcome: string;
}

/**
 * Non-exception problem, built by `violation(name)`. A plain branded object
 * (not an Error subclass). The name is the whole identity — there is no
 * separate message; any variable/context data belongs in `.extras()` on the
 * see chain, never on the violation itself.
 */
export interface Violation {
  readonly __seViolation: true;
  readonly violationName: string;
}

/**
 * Identity of a problem that see() already reported, carried on the wire as
 * the `caused_by` of a later occurrence. Holds exactly the fields the worker's
 * fingerprint function consumes (raw `message`/`stack` — the server normalizes
 * them) so the backend can recompute the prior issue's fingerprint and link
 * the two issues. See `findCausedBy` for how the link is discovered.
 */
export interface SeeCausedBy {
  error_type: string;
  message: string;
  stack?: string;
  subject: string;
  outcome: string;
}

/** Wire shape — the `type:"error"` RawEvent variant accepted by POST /collect. */
export interface SeeErrorEvent {
  type: "error";
  kind: SeeKind;
  /** Error class/name (e.g. "TypeError") or the violation name. */
  error_type: string;
  message: string;
  stack?: string;
  /** Consequence: "<error_type> causes the <subject> to <outcome>". */
  subject: string;
  outcome: string;
  extras?: Record<string, string | number | boolean>;
  url?: string;
  user_id?: string;
  anonymous_id?: string;
  side: "client" | "server";
  env?: string;
  sdk_version: string;
  ts: number;
  /**
   * Per-request correlation token. The client mints one per same-origin fetch
   * and ships it on both the request header (`X-SE-Correlation`) and any 5xx
   * occurrence it reports; the server safety net reports the matching uncaught
   * error under the same token. The backend joins the two issues by it —
   * populating `caused_by` across the network boundary, where the in-process
   * `.cause`-chain stamp (see `findCausedBy`) cannot reach. Join-only metadata,
   * never persisted as an issue field.
   */
  correlation_id?: string;
  /**
   * The earlier reported problem this occurrence descends from — present when
   * the same error was caught + reported at an inner boundary and then
   * re-thrown (or wrapped via `{ cause }`) and reported again at an outer one.
   * Lets the backend stitch the two issues into a cause chain instead of
   * double-counting them as unrelated.
   */
  caused_by?: SeeCausedBy;
}

// ---- Builders ----

/**
 * Start a consequence sentence: `causesThe("checkout").to("use cached prices")`.
 * Subject = the product surface affected; outcome = the user-visible impact.
 */
export function causesThe(subject: string): { to(outcome: string): Consequence } {
  return {
    to(outcome: string): Consequence {
      return {
        __seConsequence: true,
        subject: truncate(String(subject), SEE_MAX_SUBJECT),
        outcome: truncate(String(outcome), SEE_MAX_SUBJECT),
      };
    },
  };
}

/**
 * A non-exception problem. Prefer passing a caught Error when one exists.
 * The name is a stable identifier (it participates in the issue fingerprint) —
 * put variable data in `.extras()`, never in the name.
 */
export function violation(name: string): Violation {
  return { __seViolation: true, violationName: String(name) };
}

export function isViolation(p: unknown): p is Violation {
  return typeof p === "object" && p !== null && (p as Violation).__seViolation === true;
}

export function isConsequence(c: unknown): c is Consequence {
  return typeof c === "object" && c !== null && (c as Consequence).__seConsequence === true;
}

// ---- Expected (control-flow) exceptions ----

const EXPECTED_SYM = Symbol.for("@shipeasy/sdk:see-expected");

/** What gets stashed on an expected error: the reason plus optional debug extras. */
export interface ExpectedMark {
  because: string;
  extras?: Record<string, string | number | boolean>;
}

function readExpectedMark(err: unknown): ExpectedMark | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const v = (err as Record<symbol, unknown>)[EXPECTED_SYM];
  return v !== undefined && v !== null && typeof v === "object"
    ? (v as ExpectedMark)
    : undefined;
}

/**
 * Mark an exception as expected control flow — auto-capture skips it and
 * nothing is reported. The reason should start with "because". Optional extras
 * ride along on the mark for local debugging only — an expected exception is by
 * definition not reported, so they are never transmitted. Re-marking the same
 * error merges extras (later wins) and keeps the latest reason.
 */
export function markExpected(err: unknown, because: string, extras?: SeeExtras): void {
  if (typeof err !== "object" || err === null) return;
  const prev = readExpectedMark(err);
  const clean = sanitizeExtras(extras);
  const merged = prev?.extras || clean ? { ...prev?.extras, ...clean } : undefined;
  const mark: ExpectedMark = {
    because: String(because),
    ...(merged ? { extras: merged } : {}),
  };
  try {
    Object.defineProperty(err, EXPECTED_SYM, {
      value: mark,
      enumerable: false,
      configurable: true,
    });
  } catch {
    /* frozen/sealed error object — best effort */
  }
}

export function isExpected(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as Record<symbol, unknown>)[EXPECTED_SYM] !== undefined;
}

// ---- Caused-by linkage ----
//
// When see() reports an Error we stamp the object with this report's identity.
// If that SAME error is later caught + reported again at an outer boundary
// (re-throw), or an outer error rethrown with `{ cause }` wraps it, the next
// report walks the `.cause` chain, finds the stamp, and ships it as
// `caused_by` — so the backend links the two issues into a chain instead of
// counting them as unrelated. The stamp is non-enumerable (no JSON/serialize
// side effects) and last-write-wins so each layer links to its nearest cause.

const REPORTED_SYM = Symbol.for("@shipeasy/sdk:see-reported");

/** How far up the `.cause` chain we look for an already-reported ancestor. */
const SEE_MAX_CAUSE_DEPTH = 8;

function readReportStamp(err: unknown): SeeCausedBy | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const v = (err as Record<symbol, unknown>)[REPORTED_SYM];
  return v !== undefined && v !== null && typeof v === "object" ? (v as SeeCausedBy) : undefined;
}

/**
 * Find the nearest problem in `problem` + its `.cause` chain that see()
 * already reported, and return that prior report's identity (or undefined).
 * Cycle-guarded and depth-bounded. Must run BEFORE the current problem is
 * stamped, so the re-throw case reads the inner report rather than itself.
 */
export function findCausedBy(problem: unknown): SeeCausedBy | undefined {
  let cur: unknown = problem;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < SEE_MAX_CAUSE_DEPTH; depth++) {
    if (typeof cur !== "object" || cur === null || seen.has(cur)) break;
    seen.add(cur);
    const stamp = readReportStamp(cur);
    if (stamp) return stamp;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Record this report's identity on the Error so a later, outer report can link
 * to it. No-op for non-Error problems (violations, strings — nothing to
 * re-throw) and for frozen/sealed objects (best effort, like markExpected).
 */
export function markReported(problem: unknown, ev: SeeErrorEvent): void {
  if (!(problem instanceof Error)) return;
  const stamp: SeeCausedBy = {
    error_type: ev.error_type,
    message: ev.message,
    subject: ev.subject,
    outcome: ev.outcome,
  };
  if (ev.stack !== undefined) stamp.stack = ev.stack;
  try {
    Object.defineProperty(problem, REPORTED_SYM, {
      value: Object.freeze(stamp),
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    /* frozen/sealed error object — best effort */
  }
}

// ---- Correlation linkage (network boundary) ----
//
// The client's fetch auto-capture mints a per-request token and sends it up on
// the `X-SE-Correlation` header. It also stamps that same token onto the object
// that surfaces the failure — the thrown error (network failure) or the returned
// Response (5xx) — with this symbol. So when app code later catches that failure
// and reports it with a real consequence via see(), the report auto-carries the
// token and the backend joins it to the server-side issue reported under the
// header. This is the cross-network analogue of the caused_by stamp above: the
// in-process `.cause` chain can't cross the wire, but this token can. The stamp
// is non-enumerable (no JSON/serialize side effects) and best-effort.

const CORRELATED_SYM = Symbol.for("@shipeasy/sdk:see-correlated");

/**
 * Stamp a correlation token on an Error or Response so a later see() that
 * reports it — directly, or via `{ cause }` — picks the token up (see
 * {@link findCorrelation}). No-op for non-objects and frozen/sealed targets
 * (best effort, like {@link markReported}).
 */
export function markCorrelated(target: unknown, correlationId: string): void {
  if (typeof target !== "object" || target === null) return;
  try {
    Object.defineProperty(target, CORRELATED_SYM, {
      value: String(correlationId),
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    /* frozen/sealed target — best effort */
  }
}

/** Read the correlation stamp directly off one object (no traversal). */
function correlationStamp(o: unknown): string | undefined {
  if (typeof o !== "object" || o === null) return undefined;
  const v = (o as Record<symbol, unknown>)[CORRELATED_SYM];
  return typeof v === "string" ? v : undefined;
}

/**
 * Find the nearest correlation token on `problem`, its `.cause` chain, or the
 * transport object a wrapping HTTP-client error hangs off. The `fetch` wrapper
 * stamps the failing Response (which app code may attach as `{ cause }` when it
 * throws); the XHR wrapper stamps the `XMLHttpRequest` itself, which axios (and
 * most XHR wrappers) expose on the thrown error as `.request` and
 * `.response.request` — probed here so those clients link without a `.cause`.
 * Cycle-guarded and depth-bounded, mirroring {@link findCausedBy}.
 */
export function findCorrelation(problem: unknown): string | undefined {
  let cur: unknown = problem;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < SEE_MAX_CAUSE_DEPTH; depth++) {
    if (typeof cur !== "object" || cur === null || seen.has(cur)) break;
    seen.add(cur);
    const direct = correlationStamp(cur);
    if (direct) return direct;
    // XHR-wrapper errors (axios et al.) don't chain via `.cause`; the stamped
    // request object lives on `.request` or `.response.request`.
    const fromReq = correlationStamp((cur as { request?: unknown }).request);
    if (fromReq) return fromReq;
    const resp = (cur as { response?: { request?: unknown } }).response;
    if (resp && typeof resp === "object") {
      const fromResp = correlationStamp(resp) ?? correlationStamp(resp.request);
      if (fromResp) return fromResp;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

// ---- Sanitization ----

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Drop nullish values, stringify-truncate the rest, cap the key count.
 * Keys are kept in insertion order; excess keys are dropped.
 */
export function sanitizeExtras(
  extras?: SeeExtras,
): Record<string, string | number | boolean> | undefined {
  if (!extras || typeof extras !== "object") return undefined;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(extras)) {
    if (v === null || v === undefined) continue;
    if (n >= SEE_MAX_EXTRA_KEYS) break;
    if (typeof v === "string") out[k] = truncate(v, SEE_MAX_EXTRA_VALUE);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else continue;
    n += 1;
  }
  return n > 0 ? out : undefined;
}

// ---- Event construction ----

export interface SeeContext {
  side: "client" | "server";
  sdkVersion: string;
  env?: string;
  url?: string;
  userId?: string;
  anonId?: string;
}

/** Strip SDK-internal frames from a synthetic stack captured inside see(). */
function captureCallsiteStack(): string | undefined {
  const raw = new Error().stack;
  if (!raw) return undefined;
  const lines = raw.split("\n");
  // Drop the "Error" header plus frames that mention the SDK itself.
  const kept = lines
    .slice(1)
    .filter((l) => !/@shipeasy[\\/]sdk|see[\\/]core|captureCallsiteStack|\bsee\b\s*\(/.test(l));
  return kept.length ? kept.join("\n") : undefined;
}

export function buildSeeEvent(
  problem: unknown,
  consequence: Consequence,
  extras: SeeExtras | undefined,
  ctx: SeeContext,
  kindOverride?: SeeKind,
  correlationId?: string,
): SeeErrorEvent {
  let errorType: string;
  let message: string;
  let stack: string | undefined;
  let kind: SeeKind;

  if (isViolation(problem)) {
    errorType = problem.violationName;
    message = problem.violationName;
    stack = captureCallsiteStack();
    kind = kindOverride ?? "violation";
  } else if (problem instanceof Error) {
    errorType = problem.name || "Error";
    message = problem.message || String(problem);
    stack = problem.stack ?? undefined;
    kind = kindOverride ?? "caught";
  } else {
    // Thrown non-Error (string, object, …) — stringify defensively.
    errorType = "Error";
    message = typeof problem === "string" ? problem : safeString(problem);
    stack = captureCallsiteStack();
    kind = kindOverride ?? "caught";
  }

  const ev: SeeErrorEvent = {
    type: "error",
    kind,
    error_type: truncate(errorType, SEE_MAX_SUBJECT),
    message: truncate(message, SEE_MAX_MESSAGE),
    subject: consequence.subject,
    outcome: consequence.outcome,
    side: ctx.side,
    sdk_version: ctx.sdkVersion,
    ts: Date.now(),
  };
  if (stack) ev.stack = truncate(stack, SEE_MAX_STACK);
  // Correlation: an explicit token wins (the server passes its per-request ALS
  // token here). Otherwise pick up a token the client's fetch wrapper stamped on
  // the problem (or its `.cause` chain) — so a plain see(failedRequestError)
  // links to the backend across the wire without the caller threading anything.
  const corr = correlationId ?? findCorrelation(problem);
  if (corr) ev.correlation_id = truncate(String(corr), SEE_MAX_CORRELATION);
  // Discover the cause BEFORE stamping this problem — otherwise the re-throw
  // case (same object reported twice) would read its own fresh stamp.
  const causedBy = findCausedBy(problem);
  if (causedBy) ev.caused_by = causedBy;
  const cleanExtras = sanitizeExtras(extras);
  if (cleanExtras) ev.extras = cleanExtras;
  if (ctx.url) ev.url = truncate(ctx.url, SEE_MAX_SUBJECT);
  if (ctx.userId) ev.user_id = ctx.userId;
  if (ctx.anonId) ev.anonymous_id = ctx.anonId;
  if (ctx.env) ev.env = ctx.env;
  // Leave this report's identity on the error so the next, outer boundary that
  // catches the re-thrown error links back to it as its caused_by.
  markReported(problem, ev);
  return ev;
}

function safeString(v: unknown): string {
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

// ---- Fluent chain ----
//
// The public API is a single `see` import with a chained grammar:
//
//   see(err).causes_the("checkout").to("use cached prices").extras({ order_id });
//   see.Violation("large query")
//      .causes_the("results").to("be trimmed").extras({ rows });
//   see.ControlFlowException(err).because("because it wasn't an encoded Foo");
//
// The chain collects subject/outcome/extras synchronously and dispatches on
// the next microtask — so the report ships immediately after the statement,
// no explicit `.send()` needed, and `.extras()` can follow `.to()`. A chain
// abandoned half-way (no `.to()`) still reports with default consequence.

const scheduleMicrotask: (cb: () => void) => void =
  typeof queueMicrotask === "function"
    ? queueMicrotask
    : (cb) => {
        void Promise.resolve().then(cb);
      };

/** Dispatch target the chain flushes into — bound per side (client/server). */
export type SeeDispatch = (
  problem: unknown,
  consequence: Consequence,
  extras: SeeExtras | undefined,
  kind?: SeeKind,
) => void;

export interface SeeExtrasTail {
  /** Attach debugging metadata. Callable repeatedly — keys merge, later wins. */
  extras(extras: SeeExtras): SeeExtrasTail;
}

export interface SeeOutcomeStep {
  /** The user-visible impact: `.causes_the("checkout").to("use cached prices")`. */
  to(outcome: string): SeeExtrasTail;
}

export interface SeeChain {
  /** Start the consequence sentence — the product surface affected. */
  causes_the(subject: string): SeeOutcomeStep;
  /** camelCase alias of {@link SeeChain.causes_the}. */
  causesThe(subject: string): SeeOutcomeStep;
}

/**
 * Violations share the exception consequence grammar exactly — there is no
 * separate `.message()`. Put any variable/context data in `.extras()`.
 */
export type SeeViolationChain = SeeChain;

export interface SeeControlFlowTail {
  /**
   * Optional debugging context for the expected exception. Kept on the mark for
   * local debugging only (expected exceptions are never reported). Callable
   * repeatedly — keys merge, later wins.
   */
  extras(extras: SeeExtras): SeeControlFlowTail;
}

export interface SeeControlFlowChain {
  /** Document why the exception is expected. The reason should start with "because". */
  because(reason: string): SeeControlFlowTail;
}

export function startSeeChain(getProblem: () => unknown, dispatch: SeeDispatch): SeeChain {
  let subject: string | undefined;
  let outcome: string | undefined;
  let collected: SeeExtras | undefined;
  let flushed = false;

  scheduleMicrotask(() => {
    if (flushed) return;
    flushed = true;
    dispatch(
      getProblem(),
      // Bare noun phrase — titles render as "… causes the {subject} …", so a
      // leading article would double up ("causes the the app").
      causesThe(subject ?? "app").to(outcome ?? "hit an error"),
      collected,
    );
  });

  const tail: SeeExtrasTail = {
    extras(x: SeeExtras): SeeExtrasTail {
      if (x && typeof x === "object") collected = { ...collected, ...x };
      return tail;
    },
  };
  const step: SeeOutcomeStep = {
    to(o: string): SeeExtrasTail {
      outcome = String(o);
      return tail;
    },
  };
  const start = (s: string): SeeOutcomeStep => {
    subject = String(s);
    return step;
  };
  return { causes_the: start, causesThe: start };
}

export function startSeeViolationChain(name: string, dispatch: SeeDispatch): SeeViolationChain {
  return startSeeChain(() => violation(name), dispatch);
}

/**
 * Fluent control-flow marker: `see.ControlFlowException(e).because("because …")`.
 * `.because()` records the reason and marks the error so auto-capture skips it;
 * the optional `.extras()` tail attaches local debug context. Nothing is
 * reported — an expected exception is, by definition, not a problem.
 */
export function startControlFlowChain(err: unknown): SeeControlFlowChain {
  return {
    because(reason: string): SeeControlFlowTail {
      markExpected(err, reason);
      const tail: SeeControlFlowTail = {
        extras(x: SeeExtras): SeeControlFlowTail {
          markExpected(err, reason, x);
          return tail;
        },
      };
      return tail;
    },
  };
}

// ---- Rate limiting / dedup ----

function topStackLine(stack?: string): string {
  if (!stack) return "";
  for (const line of stack.split("\n")) {
    if (/^\s*at |@|:\d+:\d+/.test(line)) return line.trim().slice(0, 200);
  }
  return "";
}

/**
 * Client-side spam guard: identical errors within a 30s window collapse to
 * one send; a hard cap bounds total sends per session (client) or process
 * (server). The worker dedupes by fingerprint anyway — this only bounds
 * network chatter from a hot error loop.
 */
export class SeeLimiter {
  private lastSent = new Map<string, number>();
  private sent = 0;

  constructor(
    private readonly maxPerSession = SEE_MAX_PER_SESSION,
    private readonly dedupWindowMs = SEE_DEDUP_WINDOW_MS,
  ) {}

  shouldSend(ev: SeeErrorEvent): boolean {
    if (this.sent >= this.maxPerSession) return false;
    const key = `${ev.kind}|${ev.error_type}|${ev.message.slice(0, 200)}|${topStackLine(ev.stack)}`;
    const now = Date.now();
    const prev = this.lastSent.get(key);
    if (prev !== undefined && now - prev < this.dedupWindowMs) return false;
    this.lastSent.set(key, now);
    this.sent += 1;
    return true;
  }
}
