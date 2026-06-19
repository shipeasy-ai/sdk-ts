/**
 * Shared, OpenFeature-package-agnostic glue for the two providers
 * (`@shipeasy/sdk/openfeature-server` and `@shipeasy/sdk/openfeature-web`).
 *
 * This module deliberately imports NOTHING from `@openfeature/*` so it can be
 * pulled into either entrypoint without coupling to a specific OpenFeature
 * package's types. Each entrypoint maps the neutral results below onto its own
 * `ResolutionDetails` / `ErrorCode` / `StandardResolutionReasons`.
 */

/** Our flag-evaluation reasons (mirrors `FlagReason` in the server/client entry). */
export type ShipeasyFlagReason =
  | "CLIENT_NOT_READY"
  | "FLAG_NOT_FOUND"
  | "OFF"
  | "OVERRIDE"
  | "RULE_MATCH"
  | "DEFAULT";

/** Minimal user shape — structurally assignable to the SDK's `User`. */
export interface ProviderUser {
  user_id?: string;
  anonymous_id?: string;
  [attr: string]: unknown;
}

/** Neutral OpenFeature error discriminant (entrypoint maps to the real `ErrorCode`). */
export type ProviderErrorCode = "FLAG_NOT_FOUND" | "PROVIDER_NOT_READY" | "TYPE_MISMATCH";

/** How a Shipeasy boolean reason maps onto an OpenFeature reason + optional error. */
export interface MappedReason {
  /** OpenFeature `StandardResolutionReasons` value, as a plain string. */
  reason: string;
  /** Present when OpenFeature should treat this as an error and return the default. */
  errorCode?: ProviderErrorCode;
}

/**
 * Shipeasy `FlagReason` → OpenFeature reason (+ errorCode). Per doc 20:
 *   RULE_MATCH       → TARGETING_MATCH
 *   DEFAULT          → DEFAULT
 *   OFF              → DISABLED
 *   OVERRIDE         → STATIC
 *   FLAG_NOT_FOUND   → ERROR (errorCode FLAG_NOT_FOUND)
 *   CLIENT_NOT_READY → ERROR (errorCode PROVIDER_NOT_READY)
 */
const REASON_MAP: Record<ShipeasyFlagReason, MappedReason> = {
  RULE_MATCH: { reason: "TARGETING_MATCH" },
  DEFAULT: { reason: "DEFAULT" },
  OFF: { reason: "DISABLED" },
  OVERRIDE: { reason: "STATIC" },
  FLAG_NOT_FOUND: { reason: "ERROR", errorCode: "FLAG_NOT_FOUND" },
  CLIENT_NOT_READY: { reason: "ERROR", errorCode: "PROVIDER_NOT_READY" },
};

export function mapFlagReason(reason: ShipeasyFlagReason): MappedReason {
  return REASON_MAP[reason] ?? { reason: "UNKNOWN" };
}

/**
 * Convert an OpenFeature evaluation context into a Shipeasy `User`.
 * `targetingKey` becomes `user_id`; every other attribute is carried through
 * verbatim for targeting. A `user_id`/`anonymous_id` already in the context is
 * preserved when no `targetingKey` is given.
 */
export function toUser(ctx: { targetingKey?: string; [k: string]: unknown } | undefined): ProviderUser {
  if (!ctx) return {};
  const { targetingKey, ...rest } = ctx;
  const user: ProviderUser = { ...rest };
  if (typeof targetingKey === "string" && targetingKey.length > 0) {
    user.user_id = targetingKey;
  }
  return user;
}

/** Result of resolving a string/number/object flag from a Shipeasy config value. */
export type ConfigResolution<T> =
  | { kind: "match"; value: T }
  | { kind: "default" }
  | { kind: "type_mismatch"; message: string };

/**
 * Type-check a raw Shipeasy config value against the OpenFeature-requested type.
 * Absent (`undefined`) → caller returns the default with reason DEFAULT.
 * Present but wrong type → TYPE_MISMATCH (OpenFeature returns the default).
 */
export function resolveConfigValue<T>(
  raw: unknown,
  type: "string" | "number" | "boolean" | "object",
): ConfigResolution<T> {
  if (raw === undefined) return { kind: "default" };
  const ok =
    type === "object" ? typeof raw === "object" && raw !== null : typeof raw === type;
  if (!ok) {
    return {
      kind: "type_mismatch",
      message: `flag value ${JSON.stringify(raw)} is not of type ${type}`,
    };
  }
  return { kind: "match", value: raw as T };
}
