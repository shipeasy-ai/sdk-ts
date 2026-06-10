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
 * (not an Error subclass) so `.message()` can be a builder method without
 * colliding with `Error.prototype.message`.
 */
export interface Violation {
  readonly __seViolation: true;
  readonly violationName: string;
  readonly violationMessage?: string;
  /** Attach free-form detail. Variable data goes HERE (or in extras), never in the name. */
  message(msg: string): Violation;
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
 * put variable data in `.message()` or extras, never in the name.
 */
export function violation(name: string): Violation {
  const make = (msg?: string): Violation => ({
    __seViolation: true,
    violationName: String(name),
    ...(msg !== undefined ? { violationMessage: msg } : {}),
    message(m: string): Violation {
      return make(String(m));
    },
  });
  return make();
}

export function isViolation(p: unknown): p is Violation {
  return typeof p === "object" && p !== null && (p as Violation).__seViolation === true;
}

export function isConsequence(c: unknown): c is Consequence {
  return typeof c === "object" && c !== null && (c as Consequence).__seConsequence === true;
}

// ---- Expected (control-flow) exceptions ----

const EXPECTED_SYM = Symbol.for("@shipeasy/sdk:see-expected");

/**
 * Mark an exception as expected control flow — auto-capture skips it and
 * nothing is reported. The reason should start with "because".
 */
export function markExpected(err: unknown, because: string): void {
  if (typeof err !== "object" || err === null) return;
  try {
    Object.defineProperty(err, EXPECTED_SYM, {
      value: String(because),
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
): SeeErrorEvent {
  let errorType: string;
  let message: string;
  let stack: string | undefined;
  let kind: SeeKind;

  if (isViolation(problem)) {
    errorType = problem.violationName;
    message = problem.violationMessage ?? problem.violationName;
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
  const cleanExtras = sanitizeExtras(extras);
  if (cleanExtras) ev.extras = cleanExtras;
  if (ctx.url) ev.url = truncate(ctx.url, SEE_MAX_SUBJECT);
  if (ctx.userId) ev.user_id = ctx.userId;
  if (ctx.anonId) ev.anonymous_id = ctx.anonId;
  if (ctx.env) ev.env = ctx.env;
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
//   see.violation("large query").message("got 5000 rows")
//      .causes_the("results").to("be trimmed");
//   see.expected(err, "because it wasn't an encoded Foo");
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

export interface SeeViolationChain extends SeeChain {
  /** Free-form detail. Variable data goes here (or extras), never in the name. */
  message(msg: string): SeeViolationChain;
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
      causesThe(subject ?? "the app").to(outcome ?? "hit an error"),
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
  let msg: string | undefined;
  const base = startSeeChain(
    () => (msg !== undefined ? violation(name).message(msg) : violation(name)),
    dispatch,
  );
  const chain: SeeViolationChain = {
    ...base,
    message(m: string): SeeViolationChain {
      msg = String(m);
      return chain;
    },
  };
  return chain;
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
