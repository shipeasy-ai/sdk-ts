// React hooks over the headless devtools core. These depend on `react` only —
// no react-native imports — so they're portable to any React renderer; the
// styled overlay in ./components is one consumer.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DevtoolsClient } from "../devtools/api";
import { startDeviceAuth, LoginCancelled } from "../devtools/auth";
import type { DeviceAuthAdapters } from "../devtools/auth";
import { submitPublicBug, PublicTicketsDisabled } from "../devtools/public-report";
import { bugFormToPublicInput, validateBugForm } from "../devtools/forms";
import type { BugFormValues, FormErrors } from "../devtools/forms";
import type {
  BugRecord,
  ConfigRecord,
  DevtoolsSession,
  ExperimentRecord,
  GateRecord,
} from "../devtools/types";
import {
  readDevtoolsCapabilities,
  watchDevtoolsCapabilities,
} from "../devtools/capabilities";
import type { DevtoolsCapabilities } from "../devtools/types";
import { makeExpoAuthAdapters, makeSessionStorage, getAccelerometer } from "./expo-adapters";
import type { SessionStorage } from "./expo-adapters";

const SESSION_KEY = "se_devtools_session";

export interface DevtoolsConfig {
  /** The HOST APP's deep-link redirect URI (its own scheme), e.g. `acme://se-auth`. */
  scheme: string;
  /** Public client key — enables the public bug path (`tickets:public_create`). */
  clientKey?: string;
  /** Pre-select a project on the login page. */
  projectId?: string;
  edgeBaseUrl?: string;
  adminBaseUrl?: string;
}

// ── capabilities ─────────────────────────────────────────────────────────────

/** Project devtools capabilities from the configured `@shipeasy/sdk/client`
 *  singleton's eval result, read via the globalThis bridge (no extra network
 *  call, no client import). `null` until the first eval lands. */
export function useDevtoolsCapabilities(): DevtoolsCapabilities | null {
  return useSyncExternalStore(
    watchDevtoolsCapabilities,
    readDevtoolsCapabilities,
    readDevtoolsCapabilities,
  );
}

// ── auth ─────────────────────────────────────────────────────────────────────

export interface DevtoolsAuth {
  /** The stored session, or null when logged out / not yet loaded. */
  session: DevtoolsSession | null;
  /** True while the stored session is being read on mount. */
  restoring: boolean;
  /** True while the login browser round-trip is in flight. */
  loggingIn: boolean;
  /** Last login failure (cancellations are silent), cleared on retry. */
  error: string | null;
  login(): Promise<void>;
  logout(): Promise<void>;
  /** Admin API client for the current session, or null when logged out. */
  client: DevtoolsClient | null;
}

/** Device-auth session state: restores from secure storage on mount, runs the
 *  PKCE login round-trip, exposes a session-bound DevtoolsClient. A 401 from
 *  any client call clears the session automatically (key revoked/expired). */
export function useDevtoolsAuth(
  config: DevtoolsConfig,
  overrides?: { adapters?: DeviceAuthAdapters; storage?: SessionStorage },
): DevtoolsAuth {
  const [session, setSession] = useState<DevtoolsSession | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const storage = useMemo(() => overrides?.storage ?? makeSessionStorage(), [overrides?.storage]);
  const adapters = useMemo(
    () => overrides?.adapters ?? makeExpoAuthAdapters(),
    [overrides?.adapters],
  );

  useEffect(() => {
    let alive = true;
    storage
      .get(SESSION_KEY)
      .then((raw) => {
        if (!alive || !raw) return;
        try {
          const parsed = JSON.parse(raw) as DevtoolsSession;
          if (parsed.token && parsed.projectId) setSession(parsed);
        } catch {
          // corrupt entry — treat as logged out
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setRestoring(false);
      });
    return () => {
      alive = false;
    };
  }, [storage]);

  const logout = useCallback(async () => {
    setSession(null);
    await storage.remove(SESSION_KEY).catch(() => {});
  }, [storage]);

  const login = useCallback(async () => {
    setError(null);
    setLoggingIn(true);
    try {
      const s = await startDeviceAuth(
        {
          redirectUri: config.scheme,
          edgeBaseUrl: config.edgeBaseUrl,
          adminBaseUrl: config.adminBaseUrl,
          projectId: config.projectId,
        },
        adapters,
      );
      setSession(s);
      await storage.set(SESSION_KEY, JSON.stringify(s)).catch(() => {});
    } catch (e) {
      if (!(e instanceof LoginCancelled)) {
        setError(e instanceof Error ? e.message : "Login failed. Please try again.");
      }
    } finally {
      setLoggingIn(false);
    }
  }, [adapters, config.adminBaseUrl, config.edgeBaseUrl, config.projectId, config.scheme, storage]);

  // Keep the logout callback fresh inside the client's onUnauthed without
  // rebuilding the client (which would drop its memo cache) on every render.
  const logoutRef = useRef(logout);
  logoutRef.current = logout;

  const client = useMemo(() => {
    if (!session) return null;
    return new DevtoolsClient({
      token: session.token,
      projectId: session.projectId,
      adminBaseUrl: config.adminBaseUrl,
      onUnauthed: () => void logoutRef.current(),
    });
  }, [session, config.adminBaseUrl]);

  return { session, restoring, loggingIn, error, login, logout, client };
}

// ── data panels ──────────────────────────────────────────────────────────────

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh(): void;
}

/** Load `run(client)` once per client (+ per refresh). Null client → idle. */
function useClientQuery<T>(
  client: DevtoolsClient | null,
  run: (client: DevtoolsClient) => Promise<T>,
): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!client) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    runRef
      .current(client)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [client, generation]);

  const refresh = useCallback(() => {
    client?.invalidate();
    setGeneration((g) => g + 1);
  }, [client]);

  return { data, loading, error, refresh };
}

export function useGates(client: DevtoolsClient | null): QueryState<GateRecord[]> {
  return useClientQuery(client, (c) => c.gates());
}

export function useConfigs(client: DevtoolsClient | null): QueryState<ConfigRecord[]> {
  return useClientQuery(client, (c) => c.configs());
}

export function useExperiments(client: DevtoolsClient | null): QueryState<ExperimentRecord[]> {
  return useClientQuery(client, (c) => c.experiments());
}

export function useFeedback(client: DevtoolsClient | null): QueryState<BugRecord[]> {
  return useClientQuery(client, (c) => c.bugs());
}

// ── bug form ─────────────────────────────────────────────────────────────────

export interface BugFormState {
  values: Partial<BugFormValues>;
  setField(field: keyof BugFormValues & string, value: string): void;
  errors: FormErrors<BugFormValues>;
  submitting: boolean;
  /** Set after a successful submit (public path carries the ticket number). */
  result: { number?: number; deduped?: boolean } | null;
  submitError: string | null;
  /** True when the 403 said public tickets are off (button shouldn't have
   *  shown; kept for belt-and-braces messaging). */
  publicDisabled: boolean;
  submit(): Promise<void>;
  reset(): void;
}

/** One form, two submit paths: logged in → the full authed `createBug`;
 *  logged out → the public `/cli/report` intake (client key). `context` is
 *  auto-attached by the overlay (platform, app version). */
export function useBugForm(args: {
  config: DevtoolsConfig;
  client: DevtoolsClient | null;
  context?: Record<string, unknown>;
}): BugFormState {
  const [values, setValues] = useState<Partial<BugFormValues>>({});
  const [errors, setErrors] = useState<FormErrors<BugFormValues>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ number?: number; deduped?: boolean } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [publicDisabled, setPublicDisabled] = useState(false);

  const setField = useCallback((field: keyof BugFormValues & string, value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => (field in e ? { ...e, [field]: undefined } : e));
  }, []);

  const reset = useCallback(() => {
    setValues({});
    setErrors({});
    setResult(null);
    setSubmitError(null);
    setPublicDisabled(false);
  }, []);

  const { config, client, context } = args;

  const submit = useCallback(async () => {
    setSubmitError(null);
    const v = validateBugForm(values);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setSubmitting(true);
    try {
      if (client) {
        await client.createBug({ ...v.value, context: { ...v.value.context, ...context } });
        setResult({});
      } else {
        if (!config.clientKey) {
          throw new Error("Public bug reporting needs a clientKey on <ShipeasyDevtools>.");
        }
        const r = await submitPublicBug(bugFormToPublicInput(v.value, { context }), {
          clientKey: config.clientKey,
          edgeBaseUrl: config.edgeBaseUrl,
        });
        setResult(r);
      }
    } catch (e) {
      if (e instanceof PublicTicketsDisabled) {
        setPublicDisabled(true);
        setSubmitError("Public bug reporting is not enabled for this project.");
      } else {
        setSubmitError(e instanceof Error ? e.message : "Submit failed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }, [client, config.clientKey, config.edgeBaseUrl, context, values]);

  return { values, setField, errors, submitting, result, submitError, publicDisabled, submit, reset };
}

// ── shake-to-open ────────────────────────────────────────────────────────────

export interface ShakeOptions {
  /** Force-g a reading must exceed to count as a shake pulse. */
  threshold?: number;
  /** Pulses needed within the window to trigger ("shaken multiple times fast"). */
  pulses?: number;
  /** Window (ms) the pulses must land in. */
  windowMs?: number;
  /** Quiet period (ms) after a trigger before the next one can fire. */
  cooldownMs?: number;
  /** Disable the sensor subscription entirely. */
  enabled?: boolean;
}

/** Fire `onShake` on a fast repeated shake (expo-sensors Accelerometer). No-op
 *  when expo-sensors isn't installed — use the imperative `open()` instead. */
export function useShakeToOpen(onShake: () => void, options?: ShakeOptions): void {
  const { threshold = 1.8, pulses = 4, windowMs = 1200, cooldownMs = 2000, enabled = true } =
    options ?? {};
  const onShakeRef = useRef(onShake);
  onShakeRef.current = onShake;

  useEffect(() => {
    if (!enabled) return;
    const accelerometer = getAccelerometer();
    if (!accelerometer) return; // expo-sensors absent — imperative open() only

    accelerometer.setUpdateInterval(100);
    let pulseTimes: number[] = [];
    let mutedUntil = 0;
    let lastPulseAt = 0;

    const sub = accelerometer.addListener(({ x, y, z }) => {
      const now = Date.now();
      if (now < mutedUntil) return;
      const g = Math.sqrt(x * x + y * y + z * z);
      if (g < threshold) return;
      // Debounce a single swing registering as many pulses at 10 Hz.
      if (now - lastPulseAt < 150) return;
      lastPulseAt = now;
      pulseTimes = pulseTimes.filter((t) => now - t <= windowMs);
      pulseTimes.push(now);
      if (pulseTimes.length >= pulses) {
        pulseTimes = [];
        mutedUntil = now + cooldownMs;
        onShakeRef.current();
      }
    });
    return () => sub.remove();
  }, [cooldownMs, enabled, pulses, threshold, windowMs]);
}
