// @vitest-environment jsdom
//
// React Native devtools hooks — react-only (no react-native import), so they
// render under jsdom via @testing-library/react. Covers the react-hook-form
// bug form (generated zod schema validation + the public submit path), the
// engine-bridge hook, and the events ring.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  ensureEventCapture,
  useBugForm,
  useEngineBridge,
  useEventLog,
  useIdentityEmail,
} from "../react-native-devtools/hooks";
import { ENGINE_BRIDGE_KEY } from "../devtools/bridge";
import type { DevtoolsEngineBridge, DevtoolsStateEvent } from "../devtools/bridge";

function fakeBridge(overrides?: Partial<DevtoolsEngineBridge>): {
  bridge: DevtoolsEngineBridge;
  emit: (e: DevtoolsStateEvent) => void;
  notify: () => void;
} {
  const stateListeners = new Set<() => void>();
  const eventListeners = new Set<(e: DevtoolsStateEvent) => void>();
  const bridge: DevtoolsEngineBridge = {
    getFlag: () => false,
    getExperiment: () => ({ inExperiment: false, group: "control" }),
    getConfig: () => undefined,
    getUser: () => null,
    identify: async () => {},
    getOverrides: () => ({ flags: {}, configs: {}, experiments: {} }),
    setFlagOverride: () => {},
    setConfigOverride: () => {},
    setExperimentOverride: () => {},
    removeOverride: () => {},
    clearOverrides: () => {},
    subscribe: (l) => {
      stateListeners.add(l);
      return () => stateListeners.delete(l);
    },
    onEvent: (l) => {
      eventListeners.add(l);
      return () => eventListeners.delete(l);
    },
    ...overrides,
  };
  (globalThis as Record<string, unknown>)[ENGINE_BRIDGE_KEY] = bridge;
  return {
    bridge,
    emit: (e) => {
      for (const l of eventListeners) l(e);
    },
    notify: () => {
      for (const l of stateListeners) l();
    },
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[ENGINE_BRIDGE_KEY];
  vi.unstubAllGlobals();
});

describe("useBugForm (react-hook-form + generated zod schema)", () => {
  const config = { scheme: "acme://auth", clientKey: "sdk_client_k" };

  it("blocks submit on schema violations without touching the network", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    const { result } = renderHook(() => useBugForm({ config, client: null }));

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.form.formState.errors.title).toBeDefined();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("submits the public path when logged out and surfaces the ticket number", async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ number: 41, deduped: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchStub);
    const { result } = renderHook(() =>
      useBugForm({ config, client: null, context: { source: "test" } }),
    );

    act(() => {
      result.current.form.setValue("title", "Crash on open");
    });
    await act(async () => {
      await result.current.submit();
    });

    await waitFor(() => expect(result.current.result).toEqual({ number: 41, deduped: true }));
    const [url] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/cli/report");
  });

  it("sources the reporter email from the identified user instead of asking", async () => {
    fakeBridge({ getUser: () => ({ user_id: "u_1", email: "dev@acme.io" }) });
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ number: 7, deduped: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchStub);
    const { result } = renderHook(() => useBugForm({ config, client: null }));

    act(() => {
      result.current.form.setValue("title", "Crash on open");
    });
    await act(async () => {
      await result.current.submit();
    });

    await waitFor(() => expect(result.current.result).not.toBeNull());
    const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init?.body)).toContain("dev@acme.io");
  });

  it("a hand-typed reporter email beats the identity email", async () => {
    fakeBridge({ getUser: () => ({ user_id: "u_1", email: "dev@acme.io" }) });
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ number: 8, deduped: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchStub);
    const { result } = renderHook(() => useBugForm({ config, client: null }));

    act(() => {
      result.current.form.setValue("title", "Crash on open");
      result.current.form.setValue("reporterEmail", "typed@acme.io");
    });
    await act(async () => {
      await result.current.submit();
    });

    await waitFor(() => expect(result.current.result).not.toBeNull());
    const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init?.body)).toContain("typed@acme.io");
  });
});

describe("useIdentityEmail", () => {
  it("returns the identify() email, or null when absent/invalid", () => {
    const { result: none } = renderHook(() => useIdentityEmail());
    expect(none.current).toBeNull();

    fakeBridge({ getUser: () => ({ user_id: "u_1", email: "dev@acme.io" }) });
    const { result } = renderHook(() => useIdentityEmail());
    expect(result.current).toBe("dev@acme.io");

    fakeBridge({ getUser: () => ({ user_id: "u_1", email: "not-an-email" }) });
    const { result: bad } = renderHook(() => useIdentityEmail());
    expect(bad.current).toBeNull();
  });
});

describe("useEngineBridge / useEventLog", () => {
  it("returns the published bridge and re-renders on state changes", () => {
    const { bridge, notify } = fakeBridge();
    const { result } = renderHook(() => useEngineBridge());
    expect(result.current).toBe(bridge);
    act(() => notify()); // must not throw; triggers a re-read
    expect(result.current).toBe(bridge);
  });

  it("captures engine events into the shared ring, even before mount", () => {
    const { emit } = fakeBridge();
    ensureEventCapture();
    act(() => {
      emit({ kind: "override", subject: "gate x", value: "true", ts: 1 });
    });

    const { result } = renderHook(() => useEventLog());
    expect(result.current.some((e) => e.subject === "gate x")).toBe(true);

    act(() => {
      emit({ kind: "evaluate", subject: "identify", value: "u_1", ts: 2 });
    });
    expect(result.current.some((e) => e.subject === "identify")).toBe(true);
  });
});
