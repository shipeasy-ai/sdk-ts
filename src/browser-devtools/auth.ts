import type { DevtoolsOptions, DevtoolsSession } from "./types";

const SESSION_KEY = "se_dt_session";

export function loadSession(): DevtoolsSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) return JSON.parse(raw) as DevtoolsSession;
  } catch {
    /* ignore */
  }
  return null;
}

export function saveSession(s: DevtoolsSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Read the customer SDK client key from the page's `__SE_BOOTSTRAP` payload
 * (injected by the server-side `getBootstrapHtml()` in @shipeasy/sdk). The
 * key uniquely identifies the customer's project, so the auth flow can
 * resolve the project directly instead of matching by origin — which lets a
 * developer running on `localhost:3000` authorize their real production
 * project without first allow-listing localhost in dashboard settings.
 */
function readBootstrapApiKey(): string | null {
  if (typeof window === "undefined") return null;
  const bs = (window as unknown as { __SE_BOOTSTRAP?: { apiKey?: string } }).__SE_BOOTSTRAP;
  return typeof bs?.apiKey === "string" && bs.apiKey ? bs.apiKey : null;
}

/**
 * Open the admin app's /devtools-auth page in a popup. The user signs in if
 * needed, approves access, and the page postMessages an admin SDK key back
 * to this window. Works on any domain — no worker, no polling, no PKCE.
 *
 * Security: we only accept messages whose event.origin equals the adminUrl
 * origin, and the popup only posts to window.opener with a restricted target
 * origin matching our window.location.origin.
 */
export async function startDeviceAuth(
  opts: Required<DevtoolsOptions>,
  onWaiting: () => void,
): Promise<DevtoolsSession> {
  const adminOrigin = new URL(opts.adminUrl).origin;
  const ourOrigin = window.location.origin;

  // Pin a unique target name per attempt so re-signing-in (after Sign out)
  // never reuses a stale popup that the previous flow already drove through
  // window.close(). When the same name is reused, some browsers race the
  // navigation against our `popup.closed` poll and reject before the new
  // page has a chance to load.
  const targetName = `shipeasy-devtools-auth-${Date.now()}`;
  const popupUrl = new URL(`${opts.adminUrl}/devtools-auth`);
  popupUrl.searchParams.set("origin", ourOrigin);
  const sdkKey = opts.clientKey || readBootstrapApiKey();
  if (sdkKey) popupUrl.searchParams.set("sdkKey", sdkKey);
  if (opts.projectId) popupUrl.searchParams.set("projectId", opts.projectId);
  const popup = window.open(popupUrl.toString(), targetName, "width=460,height=640,noopener=no");
  if (!popup) {
    throw new Error("Popup blocked. Allow popups for this site and try again.");
  }
  try {
    popup.focus();
  } catch {
    /* ignore — focus may be denied across origins */
  }
  onWaiting();

  return new Promise<DevtoolsSession>((resolve, reject) => {
    const TIMEOUT_MS = 10 * 60_000;
    let done = false;

    function finish(err: Error | null, session?: DevtoolsSession) {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      clearInterval(closedPoll);
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve(session!);
    }

    function onMessage(ev: MessageEvent) {
      if (ev.origin !== adminOrigin) return;
      const data = ev.data as
        | { type?: string; token?: string; projectId?: string }
        | null
        | undefined;
      if (!data || data.type !== "se:devtools-auth") return;
      if (!data.token || !data.projectId) return;
      const session: DevtoolsSession = { token: data.token, projectId: data.projectId };
      saveSession(session);
      finish(null, session);
    }

    window.addEventListener("message", onMessage);

    // Detect popup closed without completing. Skip the first 1500ms so a
    // briefly-blank reused window or a slow cross-origin navigation doesn't
    // fire a false "closed" detection before the page has even loaded.
    const startedAt = Date.now();
    const closedPoll = setInterval(() => {
      if (Date.now() - startedAt < 1500) return;
      if (popup.closed && !done) {
        finish(new Error("Sign-in window closed before approval."));
      }
    }, 500);

    const timeout = setTimeout(() => {
      finish(new Error("Sign-in timed out after 10 minutes."));
    }, TIMEOUT_MS);
  });
}
