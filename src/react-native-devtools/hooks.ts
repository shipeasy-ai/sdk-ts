// React hooks over the headless devtools core. These depend on `react` only —
// no react-native imports — so they're portable to any React renderer; the
// styled overlay in ./components is one consumer.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useForm } from "react-hook-form";
import type { UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { DevtoolsClient } from "../devtools/api";
import { startDeviceAuth, LoginCancelled } from "../devtools/auth";
import type { DeviceAuthAdapters } from "../devtools/auth";
import {
  submitPublicBug,
  submitPublicFeature,
  PublicTicketsDisabled,
} from "../devtools/public-report";
import {
  bugFormSchema,
  bugFormToPublicInput,
  featureFormSchema,
  featureFormToPublicInput,
} from "../devtools/forms";
import type {
  BugFormInput,
  BugFormValues,
  FeatureFormInput,
  FeatureFormValues,
} from "../devtools/forms";
import type {
  BugDetail,
  BugRecord,
  ConfigRecord,
  DevtoolsSession,
  ExperimentRecord,
  FeatureRequestDetail,
  FeatureRequestRecord,
  GateRecord,
  KeyRecord,
  ProfileRecord,
  ProjectRecord,
  UniverseRecord,
} from "../devtools/types";
import {
  readDevtoolsCapabilities,
  watchDevtoolsCapabilities,
} from "../devtools/capabilities";
import { readEngineBridge, watchEngineBridge } from "../devtools/bridge";
import type { DevtoolsEngineBridge, DevtoolsStateEvent } from "../devtools/bridge";
import type { DevtoolsCapabilities } from "../devtools/types";
import {
  canCaptureScreen,
  captureScreenShot,
  getAccelerometer,
  makeExpoAuthAdapters,
  makeSessionStorage,
} from "./expo-adapters";
import type { CapturedScreen, SessionStorage } from "./expo-adapters";

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

// ── engine bridge (live values / user / overrides) ──────────────────────────

/** The configured `@shipeasy/sdk/client` singleton's devtools bridge, read via
 *  `globalThis` (no client import — that would inline a second Engine).
 *  `null` when the host app hasn't configured the client SDK; the overlay
 *  hides live-state UI then. Re-renders on every engine state change. */
export function useEngineBridge(): DevtoolsEngineBridge | null {
  const [bridge, setBridge] = useState<DevtoolsEngineBridge | null>(readEngineBridge);
  const [, setGen] = useState(0);
  useEffect(
    () =>
      watchEngineBridge(() => {
        setBridge(readEngineBridge());
        // The bridge object is stable across state changes — bump a counter so
        // panels re-read live values after identify()/override mutations.
        setGen((g) => g + 1);
      }),
    [],
  );
  return bridge;
}

/** The identified user's email from the engine bridge (the app's `identify()`
 *  payload), or `null` when the app hasn't identified one. The bug form
 *  sources its reporter email from here instead of asking the user for what
 *  the app already told the SDK. Live: re-reads after a late `identify()`. */
export function useIdentityEmail(): string | null {
  const bridge = useEngineBridge();
  const email = bridge?.getUser()?.["email"];
  return typeof email === "string" && email.includes("@") ? email : null;
}

// ── events feed ──────────────────────────────────────────────────────────────

const EVENT_RING_SIZE = 200;
// Module-level ring so events captured while the overlay is CLOSED still show
// when it opens (mirrors the web overlay's window-listener-at-import).
const eventRing: DevtoolsStateEvent[] = [];
const eventListeners = new Set<() => void>();
let eventCaptureStarted = false;

/** Start capturing engine events into the shared ring. Idempotent; attaches
 *  lazily when the client SDK configures after us. */
export function ensureEventCapture(): void {
  if (eventCaptureStarted) return;
  eventCaptureStarted = true;
  const attach = (bridge: DevtoolsEngineBridge) =>
    bridge.onEvent((event) => {
      eventRing.push(event);
      if (eventRing.length > EVENT_RING_SIZE) eventRing.shift();
      for (const l of eventListeners) l();
    });
  const now = readEngineBridge();
  if (now) {
    attach(now);
    return;
  }
  const timer = setInterval(() => {
    const late = readEngineBridge();
    if (late) {
      clearInterval(timer);
      attach(late);
    }
  }, 1000);
}

/** Snapshot of the captured event feed, newest last. Re-renders per event. */
export function useEventLog(): DevtoolsStateEvent[] {
  ensureEventCapture();
  const [snapshot, setSnapshot] = useState<DevtoolsStateEvent[]>(() => eventRing.slice());
  useEffect(() => {
    const listener = () => setSnapshot(eventRing.slice());
    eventListeners.add(listener);
    return () => {
      eventListeners.delete(listener);
    };
  }, []);
  return snapshot;
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
          // The auth page resolves the key to its project and locks the flow
          // there — no project picker (mirrors the browser overlay).
          clientKey: config.clientKey,
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
  }, [
    adapters,
    config.adminBaseUrl,
    config.clientKey,
    config.edgeBaseUrl,
    config.projectId,
    config.scheme,
    storage,
  ]);

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

/** Load `run(client)` once per client (+ per refresh, + per `key` change —
 *  pass the query's parameters as `key` so a new argument refetches). Null
 *  client → idle. */
function useClientQuery<T>(
  client: DevtoolsClient | null,
  run: (client: DevtoolsClient) => Promise<T>,
  key = "",
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
  }, [client, generation, key]);

  const refresh = useCallback(() => {
    client?.invalidate();
    setGeneration((g) => g + 1);
  }, [client]);

  return { data, loading, error, refresh };
}

export function useProject(client: DevtoolsClient | null): QueryState<ProjectRecord> {
  return useClientQuery(client, (c) => c.project());
}

export function useGates(client: DevtoolsClient | null): QueryState<GateRecord[]> {
  return useClientQuery(client, (c) => c.gates());
}

export function useConfigs(client: DevtoolsClient | null): QueryState<ConfigRecord[]> {
  return useClientQuery(client, (c) => c.configs());
}

/** The non-archived experiments (running / draft / stopped) — one list call. */
export function useExperiments(client: DevtoolsClient | null): QueryState<ExperimentRecord[]> {
  return useClientQuery(client, (c) => c.experiments());
}

/** The archived experiments (the archive tab is a separate endpoint). */
export function useArchivedExperiments(
  client: DevtoolsClient | null,
): QueryState<ExperimentRecord[]> {
  return useClientQuery(client, (c) => c.experiments({ archived: true }), "exp:archived");
}

export function useUniverses(client: DevtoolsClient | null): QueryState<UniverseRecord[]> {
  return useClientQuery(client, (c) => c.universes());
}

export function useFeedback(client: DevtoolsClient | null): QueryState<BugRecord[]> {
  return useClientQuery(client, (c) => c.bugs());
}

export function useFeatureRequests(
  client: DevtoolsClient | null,
): QueryState<FeatureRequestRecord[]> {
  return useClientQuery(client, (c) => c.featureRequests());
}

export function useBugDetail(
  client: DevtoolsClient | null,
  id: string | null,
): QueryState<BugDetail> {
  return useClientQuery(id ? client : null, (c) => c.bug(id as string), id ?? "");
}

export function useFeatureDetail(
  client: DevtoolsClient | null,
  id: string | null,
): QueryState<FeatureRequestDetail> {
  return useClientQuery(id ? client : null, (c) => c.featureRequest(id as string), id ?? "");
}

export function useProfiles(client: DevtoolsClient | null): QueryState<ProfileRecord[]> {
  return useClientQuery(client, (c) => c.profiles());
}

export function useI18nKeys(
  client: DevtoolsClient | null,
  profileId: string | null,
): QueryState<KeyRecord[]> {
  return useClientQuery(client, (c) => c.keys(profileId ?? undefined), profileId ?? "");
}

// ── screen capture ───────────────────────────────────────────────────────────

/** How the report forms take a screenshot of the CURRENT app screen. The
 *  overlay root provides an implementation that hides the sheet for the shot;
 *  the default (forms rendered outside the sheet — e.g. a design gallery)
 *  captures as-is. `available` gates the button. */
export interface ScreenCapture {
  available: boolean;
  /** Null on cancel / module absence / capture failure. */
  capture(): Promise<CapturedScreen | null>;
}

export const ScreenCaptureContext = createContext<ScreenCapture>({
  available: canCaptureScreen(),
  capture: () => captureScreenShot().catch(() => null),
});

export function useScreenCapture(): ScreenCapture {
  return useContext(ScreenCaptureContext);
}

/** Attach a captured screen to a just-filed report through the authed
 *  attachments API (the same storage the browser overlay files into).
 *  Best-effort: the ticket is already filed — a failed upload must not turn
 *  the submit into an error. */
async function uploadCapturedScreen(
  client: DevtoolsClient,
  reportKind: "bug" | "feature_request",
  reportId: string,
  shot: CapturedScreen,
): Promise<void> {
  try {
    // RN's fetch materializes local file:// URIs (and data: URIs on web).
    const blob = await (await fetch(shot.uri)).blob();
    await client.uploadAttachment({
      reportKind,
      reportId,
      kind: "screenshot",
      filename: shot.filename,
      blob,
    });
  } catch {
    /* report filed; it just has no image */
  }
}

// ── bug form ─────────────────────────────────────────────────────────────────
//
// Form state is react-hook-form; validation is the GENERATED zod schema
// (`bugFormSchema`, from the admin OpenAPI contract) via `zodResolver` — the
// hooks add only what RHF can't know: which endpoint a submit goes to.

export interface BugFormState {
  /** react-hook-form instance — drive fields with `<Controller control={…}>`. */
  form: UseFormReturn<BugFormInput, unknown, BugFormValues>;
  submitting: boolean;
  /** Set after a successful submit (public path carries the ticket number). */
  result: { number?: number; deduped?: boolean } | null;
  submitError: string | null;
  /** True when the 403 said public tickets are off (button shouldn't have
   *  shown; kept for belt-and-braces messaging). */
  publicDisabled: boolean;
  /** Captured screen pending upload with the report (authed submits only —
   *  the public intake takes no attachments). */
  screenshot: CapturedScreen | null;
  setScreenshot(shot: CapturedScreen | null): void;
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
  const form = useForm<BugFormInput, unknown, BugFormValues>({
    resolver: zodResolver(bugFormSchema),
    defaultValues: { title: "", stepsToReproduce: "", actualResult: "", expectedResult: "" },
  });
  const [result, setResult] = useState<{ number?: number; deduped?: boolean } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [publicDisabled, setPublicDisabled] = useState(false);
  const [screenshot, setScreenshot] = useState<CapturedScreen | null>(null);
  const identityEmail = useIdentityEmail();

  const { config, client, context } = args;

  const submit = useCallback(async () => {
    setSubmitError(null);
    await form.handleSubmit(async (raw) => {
      // Reporter email is sourced from identify() when the app provided one —
      // the form only asks when the identity has no email.
      const value = { ...raw, reporterEmail: raw.reporterEmail || identityEmail || undefined };
      try {
        if (client) {
          const created = await client.createBug({
            ...value,
            context: { ...value.context, ...context },
          });
          if (screenshot) await uploadCapturedScreen(client, "bug", created.id, screenshot);
          setResult({});
        } else {
          if (!config.clientKey) {
            throw new Error("Public bug reporting needs a clientKey on <ShipeasyDevtools>.");
          }
          const r = await submitPublicBug(bugFormToPublicInput(value, { context }), {
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
      }
    })();
  }, [client, config.clientKey, config.edgeBaseUrl, context, form, identityEmail, screenshot]);

  const reset = useCallback(() => {
    form.reset();
    setResult(null);
    setSubmitError(null);
    setPublicDisabled(false);
    setScreenshot(null);
  }, [form]);

  return {
    form,
    submitting: form.formState.isSubmitting,
    result,
    submitError,
    publicDisabled,
    screenshot,
    setScreenshot,
    submit,
    reset,
  };
}

// ── feature-request form ─────────────────────────────────────────────────────

export interface FeatureFormState {
  /** react-hook-form instance — drive fields with `<Controller control={…}>`. */
  form: UseFormReturn<FeatureFormInput, unknown, FeatureFormValues>;
  submitting: boolean;
  /** Authed path sets `id`; the public path carries the ticket number. */
  result: { id?: string; number?: number; deduped?: boolean } | null;
  submitError: string | null;
  /** True when the 403 said public tickets are off. */
  publicDisabled: boolean;
  /** Captured screen pending upload with the request (authed submits only). */
  screenshot: CapturedScreen | null;
  setScreenshot(shot: CapturedScreen | null): void;
  submit(): Promise<void>;
  reset(): void;
}

/** Feature-request counterpart of {@link useBugForm} — same two submit paths:
 *  logged in → the full authed `createFeatureRequest`; logged out → the public
 *  `/cli/report` intake (`type: "feature"`, client key). */
export function useFeatureForm(args: {
  config: DevtoolsConfig;
  client: DevtoolsClient | null;
  context?: Record<string, unknown>;
}): FeatureFormState {
  const form = useForm<FeatureFormInput, unknown, FeatureFormValues>({
    resolver: zodResolver(featureFormSchema),
    defaultValues: { title: "", description: "", useCase: "" },
  });
  const [result, setResult] = useState<{
    id?: string;
    number?: number;
    deduped?: boolean;
  } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [publicDisabled, setPublicDisabled] = useState(false);
  const [screenshot, setScreenshot] = useState<CapturedScreen | null>(null);
  const identityEmail = useIdentityEmail();

  const { config, client, context } = args;

  const submit = useCallback(async () => {
    setSubmitError(null);
    await form.handleSubmit(async (raw) => {
      const value = { ...raw, reporterEmail: raw.reporterEmail || identityEmail || undefined };
      try {
        if (client) {
          const created = await client.createFeatureRequest({
            ...value,
            context: { ...value.context, ...context },
          });
          if (screenshot) {
            await uploadCapturedScreen(client, "feature_request", created.id, screenshot);
          }
          setResult(created);
        } else {
          if (!config.clientKey) {
            throw new Error("Public feature requests need a clientKey on <ShipeasyDevtools>.");
          }
          const r = await submitPublicFeature(featureFormToPublicInput(value, { context }), {
            clientKey: config.clientKey,
            edgeBaseUrl: config.edgeBaseUrl,
          });
          setResult(r);
        }
      } catch (e) {
        if (e instanceof PublicTicketsDisabled) {
          setPublicDisabled(true);
          setSubmitError("Public feature requests are not enabled for this project.");
        } else {
          setSubmitError(e instanceof Error ? e.message : "Submit failed. Please try again.");
        }
      }
    })();
  }, [client, config.clientKey, config.edgeBaseUrl, context, form, identityEmail, screenshot]);

  const reset = useCallback(() => {
    form.reset();
    setResult(null);
    setSubmitError(null);
    setPublicDisabled(false);
    setScreenshot(null);
  }, [form]);

  return {
    form,
    submitting: form.formState.isSubmitting,
    result,
    submitError,
    publicDisabled,
    screenshot,
    setScreenshot,
    submit,
    reset,
  };
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
