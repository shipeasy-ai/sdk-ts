// Headless devtools core — DevtoolsClient transport/caching, the PKCE
// device-auth flow, the public bug intake, and the shared form schemas.
// Hermetic: every network call goes through an injected fetch stub.

import { describe, expect, it, vi } from "vitest";
import { AuthError, DevtoolsClient } from "../devtools/api";
import { LoginCancelled, parseDeepLinkQuery, startDeviceAuth } from "../devtools/auth";
import { PublicTicketsDisabled, submitPublicBug } from "../devtools/public-report";
import { bugFormToPublicInput, validateBugForm } from "../devtools/forms";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** SHA-256 → base64url via node's crypto.subtle (same transform the worker verifies). */
async function s256(input: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Buffer.from(hash).toString("base64url");
}

// ── DevtoolsClient ────────────────────────────────────────────────────────────

describe("DevtoolsClient", () => {
  it("sends the admin bearer token and unwraps {data} bodies", async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://admin.test/api/admin/projects/proj_1",
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sdk_admin_x");
      return jsonResponse({ data: { id: "proj_1", name: "P", domain: null } });
    });
    const client = new DevtoolsClient({
      token: "sdk_admin_x",
      projectId: "proj_1",
      adminBaseUrl: "https://admin.test",
      fetch: fetchStub as unknown as typeof fetch,
    });
    const project = await client.project();
    expect(project.name).toBe("P");
    // All module flags default true when the endpoint omits them.
    expect(project.modules.feedback).toBe(true);
  });

  it("memoizes list reads until invalidate(), and drains cursored pages", async () => {
    const pages = [
      { data: [{ id: "g1" }], next_cursor: "c1" },
      { data: [{ id: "g2" }], next_cursor: null },
    ];
    let call = 0;
    const fetchStub = vi.fn(async () => jsonResponse(pages[call++] ?? { data: [], next_cursor: null }));
    const client = new DevtoolsClient({
      token: "t",
      projectId: "p",
      adminBaseUrl: "https://admin.test",
      fetch: fetchStub as unknown as typeof fetch,
    });

    const gates = await client.gates();
    expect(gates.map((g) => g.id)).toEqual(["g1", "g2"]);
    await client.gates(); // memoized — no extra fetches
    expect(fetchStub).toHaveBeenCalledTimes(2);

    client.invalidate();
    call = 0;
    await client.gates();
    expect(fetchStub).toHaveBeenCalledTimes(4);
  });

  it("fires onUnauthed and rejects with AuthError on a 401", async () => {
    const onUnauthed = vi.fn();
    const client = new DevtoolsClient({
      token: "stale",
      projectId: "p",
      adminBaseUrl: "https://admin.test",
      onUnauthed,
      fetch: (async () => jsonResponse({ error: "expired" }, 401)) as unknown as typeof fetch,
    });
    await expect(client.gates()).rejects.toBeInstanceOf(AuthError);
    expect(onUnauthed).toHaveBeenCalledTimes(1);
  });

  it("createBug injects the type discriminator and busts the bugs cache", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    let bugsServed = 0;
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (init?.method === "POST") return jsonResponse({ id: "bug_1" });
      bugsServed++;
      return jsonResponse([{ id: `bug_list_${bugsServed}` }]);
    });
    const client = new DevtoolsClient({
      token: "t",
      projectId: "p",
      adminBaseUrl: "https://admin.test",
      fetch: fetchStub as unknown as typeof fetch,
    });

    await client.bugs();
    await client.createBug({ title: "It broke" });
    const post = calls.find((c) => c.body);
    expect(post?.body).toMatchObject({ title: "It broke", type: "bug" });

    // The bugs memo was scrubbed by the mutation — next read refetches.
    await client.bugs();
    expect(bugsServed).toBe(2);
  });
});

// ── startDeviceAuth (PKCE code-exchange) ─────────────────────────────────────

describe("startDeviceAuth", () => {
  function makeFetchStub(opts?: { tokenStatus?: number }) {
    const seen: Record<string, unknown> = {};
    const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith("/auth/device/start")) {
        seen.challenge = body.code_challenge;
        return jsonResponse({ state: "state-1", expires_at: "2099-01-01T00:00:00Z" }, 201);
      }
      if (url.endsWith("/auth/device/token")) {
        seen.exchange = body;
        if (opts?.tokenStatus) return jsonResponse({ error: "nope" }, opts.tokenStatus);
        // The worker verifies base64url(sha256(verifier)) === challenge; mirror it.
        return s256(body.code_verifier).then((derived) =>
          derived === seen.challenge
            ? jsonResponse({
                token: "sdk_admin_minted",
                project_id: "proj_9",
                user_email: "dev@x.test",
                project_name: "Proj Nine",
              })
            : jsonResponse({ error: "PKCE verification failed" }, 401),
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    return { stub, seen };
  }

  it("runs start → browser → exchange and returns the session", async () => {
    const { stub } = makeFetchStub();
    let authUrl = "";
    const session = await startDeviceAuth(
      { redirectUri: "acme://se-auth", edgeBaseUrl: "https://edge.test", adminBaseUrl: "https://admin.test" },
      {
        fetch: stub as unknown as typeof fetch,
        openAuthSession: async (url) => {
          authUrl = url;
          // The web page bounces back with ONLY state — never a token.
          return { type: "success", url: "acme://se-auth?state=state-1" };
        },
      },
    );
    expect(session).toEqual({
      token: "sdk_admin_minted",
      projectId: "proj_9",
      userEmail: "dev@x.test",
      projectName: "Proj Nine",
    });
    // The auth URL carries the app's own scheme + the S256 challenge.
    expect(authUrl).toContain("https://admin.test/cli-auth?state=state-1");
    expect(authUrl).toContain(`redirect_uri=${encodeURIComponent("acme://se-auth")}`);
    expect(authUrl).toContain("code_challenge=");
  });

  it("throws LoginCancelled when the user dismisses the browser", async () => {
    const { stub } = makeFetchStub();
    await expect(
      startDeviceAuth(
        { redirectUri: "acme://a", edgeBaseUrl: "https://edge.test" },
        {
          fetch: stub as unknown as typeof fetch,
          openAuthSession: async () => ({ type: "dismiss" }),
        },
      ),
    ).rejects.toBeInstanceOf(LoginCancelled);
  });

  it("rejects on a state mismatch (CSRF) without exchanging", async () => {
    const { stub, seen } = makeFetchStub();
    await expect(
      startDeviceAuth(
        { redirectUri: "acme://a", edgeBaseUrl: "https://edge.test" },
        {
          fetch: stub as unknown as typeof fetch,
          openAuthSession: async () => ({ type: "success", url: "acme://a?state=EVIL" }),
        },
      ),
    ).rejects.toThrow("Auth state mismatch");
    expect(seen.exchange).toBeUndefined();
  });

  it("surfaces an exchange rejection as a login failure", async () => {
    const { stub } = makeFetchStub({ tokenStatus: 404 });
    await expect(
      startDeviceAuth(
        { redirectUri: "acme://a", edgeBaseUrl: "https://edge.test" },
        {
          fetch: stub as unknown as typeof fetch,
          openAuthSession: async () => ({ type: "success", url: "acme://a?state=state-1" }),
        },
      ),
    ).rejects.toThrow("HTTP 404");
  });
});

describe("parseDeepLinkQuery", () => {
  it("parses query params off a custom-scheme deep link", () => {
    expect(parseDeepLinkQuery("acme://se-auth?state=s%201&x=1#frag")).toEqual({
      state: "s 1",
      x: "1",
    });
    expect(parseDeepLinkQuery("acme://se-auth")).toEqual({});
  });
});

// ── submitPublicBug ──────────────────────────────────────────────────────────

describe("submitPublicBug", () => {
  it("POSTs /cli/report with the client key and maps the result", async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://edge.test/cli/report");
      expect((init?.headers as Record<string, string>)["X-SDK-Key"]).toBe("sdk_client_pub");
      expect(JSON.parse(String(init?.body))).toEqual({
        title: "Crash on open",
        error: "TypeError: x is undefined",
        reporter_email: "me@x.test",
        step: "RN devtools",
        context: { os: "ios" },
      });
      return jsonResponse({ number: 7 }, 201);
    });
    const r = await submitPublicBug(
      {
        title: "Crash on open",
        error: "TypeError: x is undefined",
        reporterEmail: "me@x.test",
        step: "RN devtools",
        context: { os: "ios" },
      },
      { clientKey: "sdk_client_pub", edgeBaseUrl: "https://edge.test", fetch: fetchStub as unknown as typeof fetch },
    );
    expect(r).toEqual({ number: 7, deduped: false });
  });

  it("maps a dedupe response", async () => {
    const r = await submitPublicBug(
      { title: "Same again" },
      {
        clientKey: "k",
        edgeBaseUrl: "https://edge.test",
        fetch: (async () => jsonResponse({ number: 3, deduped: true })) as unknown as typeof fetch,
      },
    );
    expect(r).toEqual({ number: 3, deduped: true });
  });

  it("throws PublicTicketsDisabled on 403 (project not opted in)", async () => {
    await expect(
      submitPublicBug(
        { title: "T" },
        {
          clientKey: "k",
          edgeBaseUrl: "https://edge.test",
          fetch: (async () =>
            jsonResponse(
              { error: "Public ticket creation is not enabled for this project" },
              403,
            )) as unknown as typeof fetch,
        },
      ),
    ).rejects.toBeInstanceOf(PublicTicketsDisabled);
  });
});

// ── forms ────────────────────────────────────────────────────────────────────

describe("bug form schema", () => {
  it("accepts a minimal valid bug and applies defaults", () => {
    const r = validateBugForm({ title: "Broken button" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe("Broken button");
      expect(r.value.stepsToReproduce).toBe(""); // generated default
    }
  });

  it("rejects a missing/whitespace-padded title with a field-keyed error", () => {
    const r = validateBugForm({ title: " padded " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toContain("title");
  });

  it("projects form values onto the public /cli/report shape", () => {
    const v = validateBugForm({
      title: "T",
      stepsToReproduce: "1. open app",
      actualResult: "crash",
      reporterEmail: "me@x.test",
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(bugFormToPublicInput(v.value, { step: "shake overlay", context: { os: "ios" } })).toEqual({
      title: "T",
      error: "crash",
      description: "1. open app",
      reporterEmail: "me@x.test",
      step: "shake overlay",
      context: { os: "ios" },
    });
  });
});
