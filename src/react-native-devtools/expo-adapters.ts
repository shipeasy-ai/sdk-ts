// Optional Expo module wiring. Every expo-* package is an OPTIONAL peer — we
// resolve them with a guarded require so the overlay degrades gracefully when
// one is absent (Metro supports optional dependencies inside try/catch;
// `transformer.allowOptionalDependencies` is on by default in Expo projects):
//   • expo-web-browser  — required to LOG IN (openAuthSessionAsync). Without it
//     login rejects with a descriptive error; the rest of the overlay works.
//   • expo-crypto       — PKCE S256 digest. Falls back to crypto.subtle when
//     the runtime provides it.
//   • expo-secure-store — session persistence (Keychain/Keystore). Without it
//     the session lives in memory for the app run only.
//   • expo-sensors      — shake-to-open. Without it use the imperative
//     `ref.open()` handle.

import type { AuthSessionResult, DeviceAuthAdapters } from "../devtools/auth";

interface WebBrowserModule {
  openAuthSessionAsync(url: string, redirectUrl: string): Promise<AuthSessionResult>;
}
interface CryptoModule {
  digestStringAsync(
    algorithm: string,
    data: string,
    options: { encoding: string },
  ): Promise<string>;
  CryptoDigestAlgorithm: { SHA256: string };
  CryptoEncoding: { BASE64: string };
}
interface SecureStoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}
export interface AccelerometerSubscription {
  remove(): void;
}
export interface AccelerometerModule {
  setUpdateInterval(ms: number): void;
  addListener(cb: (data: { x: number; y: number; z: number }) => void): AccelerometerSubscription;
}

// Static `require("expo-…")` literals, one per module: Metro only resolves
// LITERAL require paths, so a `require(name)` helper would leave the modules
// unreachable even when installed. Each literal sits in its own try/catch so a
// missing package degrades that one capability (Metro's
// `allowOptionalDependencies` — on by default in Expo — permits the miss).
/* eslint-disable @typescript-eslint/no-require-imports */
let webBrowser: WebBrowserModule | null = null;
try {
  webBrowser = require("expo-web-browser") as WebBrowserModule;
} catch {
  /* optional — login will explain */
}
let expoCrypto: CryptoModule | null = null;
try {
  expoCrypto = require("expo-crypto") as CryptoModule;
} catch {
  /* optional — falls back to crypto.subtle */
}
let secureStore: SecureStoreModule | null = null;
try {
  secureStore = require("expo-secure-store") as SecureStoreModule;
} catch {
  /* optional — in-memory session */
}
let expoSensors: { Accelerometer?: AccelerometerModule } | null = null;
try {
  expoSensors = require("expo-sensors") as { Accelerometer?: AccelerometerModule };
} catch {
  /* optional — imperative open() only */
}
/* eslint-enable @typescript-eslint/no-require-imports */

export function getAccelerometer(): AccelerometerModule | null {
  return expoSensors?.Accelerometer ?? null;
}

function base64ToBase64Url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Device-auth adapters wired to the Expo modules that are installed. Throws a
 *  descriptive error from `openAuthSession` when expo-web-browser is missing —
 *  surfaced by the login button, not at import time. */
export function makeExpoAuthAdapters(): DeviceAuthAdapters {
  return {
    openAuthSession(url: string, redirectUri: string): Promise<AuthSessionResult> {
      if (!webBrowser) {
        return Promise.reject(
          new Error(
            "Shipeasy devtools login needs expo-web-browser — install it with `npx expo install expo-web-browser`.",
          ),
        );
      }
      return webBrowser.openAuthSessionAsync(url, redirectUri);
    },
    ...(expoCrypto
      ? {
          async sha256Base64Url(input: string): Promise<string> {
            const b64 = await expoCrypto.digestStringAsync(
              expoCrypto.CryptoDigestAlgorithm.SHA256,
              input,
              { encoding: expoCrypto.CryptoEncoding.BASE64 },
            );
            return base64ToBase64Url(b64);
          },
        }
      : {}), // no expo-crypto → the core falls back to crypto.subtle
  };
}

// ── Session persistence ──────────────────────────────────────────────────────

export interface SessionStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** True when backed by the OS keychain (vs the in-memory fallback). */
  readonly persistent: boolean;
}

const memory = new Map<string, string>();

/** SecureStore-backed storage, or an in-memory fallback (session survives the
 *  app run only) when expo-secure-store isn't installed. */
export function makeSessionStorage(): SessionStorage {
  if (secureStore) {
    return {
      persistent: true,
      get: (k) => secureStore.getItemAsync(k),
      set: (k, v) => secureStore.setItemAsync(k, v),
      remove: (k) => secureStore.deleteItemAsync(k),
    };
  }
  return {
    persistent: false,
    get: async (k) => memory.get(k) ?? null,
    set: async (k, v) => {
      memory.set(k, v);
    },
    remove: async (k) => {
      memory.delete(k);
    },
  };
}
