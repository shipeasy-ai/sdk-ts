// Leveled logger shared by the server + client entrypoints.
//
// Every diagnostic the SDK emits from a *caught* error goes through here, so a
// single `logLevel` config option (default "warn") controls the whole SDK's
// console output. The contract for the SDK's public runtime methods (getFlag,
// getConfig, getExperiment, getKillswitch, track, logExposure, see, …) is that
// they NEVER throw into product code — so logging itself is best-effort too: a
// missing or throwing `console` can never take down a flag read.
//
// Level ordering (a message at level L is printed iff the configured level is at
// least as verbose as L):
//   silent < error < warn < info < debug
// "warn" (the default) therefore prints `error` + `warn`, and suppresses the
// informational `info` / `debug` chatter.

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

/** All accepted {@link LogLevel} values, in increasing verbosity. */
export const LOG_LEVELS: readonly LogLevel[] = ["silent", "error", "warn", "info", "debug"];

const RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

// Module-scoped level. The server and client entrypoints are separate bundles,
// so each carries its own copy of this module — configuring the server never
// changes the browser's level and vice-versa, which is exactly what we want.
let currentLevel: LogLevel = "warn";

/**
 * Set the SDK-wide log level. Called from `configure()` / `shipeasy()` with the
 * caller's `logLevel` option. An undefined or unrecognised value is ignored so a
 * bad config value can never silence a genuine error unexpectedly — the level
 * simply stays at its current (default "warn").
 */
export function setLogLevel(level: LogLevel | string | undefined | null): void {
  if (typeof level === "string" && Object.prototype.hasOwnProperty.call(RANK, level)) {
    currentLevel = level as LogLevel;
  }
}

/** The current SDK-wide log level. */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

type ConsoleMethod = "error" | "warn" | "info" | "debug";

function write(method: ConsoleMethod, args: readonly unknown[]): void {
  try {
    const c = (globalThis as { console?: Partial<Record<ConsoleMethod | "log", (...a: unknown[]) => void>> })
      .console;
    if (!c) return;
    const fn = c[method] ?? c.log;
    if (typeof fn === "function") fn.call(c, ...args);
  } catch {
    /* logging must never throw into product code */
  }
}

/**
 * The SDK logger. Each method is a no-op when the configured level doesn't reach
 * it, so callers can pass the same `[shipeasy] …` messages they always have —
 * the level gating happens here, once.
 */
export const logger = {
  error(...args: unknown[]): void {
    if (RANK[currentLevel] >= RANK.error) write("error", args);
  },
  warn(...args: unknown[]): void {
    if (RANK[currentLevel] >= RANK.warn) write("warn", args);
  },
  info(...args: unknown[]): void {
    if (RANK[currentLevel] >= RANK.info) write("info", args);
  },
  debug(...args: unknown[]): void {
    if (RANK[currentLevel] >= RANK.debug) write("debug", args);
  },
};

/**
 * Run `fn` and return its value; if it throws, log at `error` and return
 * `fallback`. The last-resort guard that makes a public runtime method
 * (getFlag/getConfig/…) unable to throw into product code, even if an internal
 * invariant is violated. `label` names the method for the log line.
 */
export function safeRun<T>(label: string, fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    logger.error(`[shipeasy] ${label} failed — returning safe default:`, String(err));
    return fallback;
  }
}
