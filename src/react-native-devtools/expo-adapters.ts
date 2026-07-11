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
//   • expo-image-picker — attach screenshots to bug reports / feedback items.
//     Without it the attach button is hidden.
//   • react-native-view-shot — capture the CURRENT app screen for a report
//     (the overlay hides itself for the shot). Without it the capture button
//     is hidden.

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
export interface PickedImage {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
}
export interface ImagePickerModule {
  launchImageLibraryAsync(options: {
    mediaTypes: string[];
    quality: number;
  }): Promise<{ canceled: boolean; assets?: PickedImage[] | null }>;
}
export interface ViewShotModule {
  captureScreen(options: { format: string; quality: number; result: string }): Promise<string>;
}
/** A captured screen, ready to preview (`uri` renders in an <Image>) and to
 *  upload (`fetch(uri)` → Blob — RN's fetch resolves local file:// URIs). */
export interface CapturedScreen {
  uri: string;
  filename: string;
  mimeType: string;
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
let imagePicker: ImagePickerModule | null = null;
try {
  imagePicker = require("expo-image-picker") as ImagePickerModule;
} catch {
  /* optional — the attach button hides */
}
let viewShot: ViewShotModule | null = null;
try {
  viewShot = require("react-native-view-shot") as ViewShotModule;
} catch {
  /* optional — the capture-screen button hides */
}
/* eslint-enable @typescript-eslint/no-require-imports */

export function getAccelerometer(): AccelerometerModule | null {
  return expoSensors?.Accelerometer ?? null;
}

export function getImagePicker(): ImagePickerModule | null {
  return imagePicker;
}

/** Pick an image from the library and materialize it as an upload-ready blob.
 *  Returns null when the module is absent or the user cancels. */
export async function pickImageAttachment(): Promise<{
  blob: Blob;
  filename: string;
} | null> {
  if (!imagePicker) return null;
  const result = await imagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.8,
  });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  // RN's fetch resolves local file:// URIs to a Blob — the same object the
  // shared core's uploadAttachment() appends to FormData.
  const blob = await (await fetch(asset.uri)).blob();
  const filename =
    asset.fileName || `screenshot-${Date.now()}.${(asset.mimeType ?? "image/png").split("/")[1] ?? "png"}`;
  return { blob, filename };
}

/** True when react-native-view-shot is installed (the capture button shows). */
export function canCaptureScreen(): boolean {
  return viewShot !== null;
}

/** Capture the current screen to a tmpfile. The CALLER is responsible for
 *  hiding the overlay first — this only takes the shot. Null when the module
 *  is absent. */
export async function captureScreenShot(): Promise<CapturedScreen | null> {
  if (!viewShot) return null;
  const uri = await viewShot.captureScreen({ format: "jpg", quality: 0.85, result: "tmpfile" });
  return { uri, filename: `screen-${Date.now()}.jpg`, mimeType: "image/jpeg" };
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
