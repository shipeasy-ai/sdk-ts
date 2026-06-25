/**
 * OpenFeature **web** provider for Shipeasy.
 *
 * ```ts
 * import { OpenFeature } from "@openfeature/web-sdk";
 * import { Engine } from "@shipeasy/sdk/client";
 * import { ShipeasyProvider } from "@shipeasy/sdk/openfeature-web";
 *
 * const client = new Engine({ sdkKey: NEXT_PUBLIC_SHIPEASY_CLIENT_KEY });
 * await OpenFeature.setContext({ targetingKey: "u1", plan: "pro" });
 * await OpenFeature.setProviderAndWait(new ShipeasyProvider(client));
 *
 * const on = OpenFeature.getClient().getBooleanValue("new_checkout", false);
 * ```
 *
 * The browser evaluates at the edge, so the provider maps OpenFeature's static
 * context onto `client.identify()` (via `initialize` + `onContextChange`) and
 * reads the cached eval result synchronously in the resolve methods.
 * `@openfeature/web-sdk` is an optional peer dependency.
 */
import type {
  EvaluationContext,
  JsonValue,
  Logger,
  Provider,
  ResolutionDetails,
} from "@openfeature/web-sdk";
import { ErrorCode } from "@openfeature/web-sdk";

import { Engine } from "../client/index";
import {
  mapFlagReason,
  resolveConfigValue,
  toUser,
  type ProviderErrorCode,
  type ShipeasyFlagReason,
} from "../openfeature/shared";

const ERROR_CODE: Record<ProviderErrorCode, ErrorCode> = {
  FLAG_NOT_FOUND: ErrorCode.FLAG_NOT_FOUND,
  PROVIDER_NOT_READY: ErrorCode.PROVIDER_NOT_READY,
  TYPE_MISMATCH: ErrorCode.TYPE_MISMATCH,
};

function resolveConfig<T extends JsonValue>(
  raw: unknown,
  defaultValue: T,
  type: "string" | "number" | "object",
): ResolutionDetails<T> {
  const r = resolveConfigValue<T>(raw, type);
  if (r.kind === "default") return { value: defaultValue, reason: "DEFAULT" };
  if (r.kind === "type_mismatch") {
    return {
      value: defaultValue,
      reason: "ERROR",
      errorCode: ERROR_CODE.TYPE_MISMATCH,
      errorMessage: r.message,
    };
  }
  return { value: r.value, reason: "TARGETING_MATCH" };
}

/**
 * Shipeasy OpenFeature provider (client/web paradigm). Wraps a
 * `Engine`. Context changes are reconciled through `identify()`;
 * flag reads come from the cached eval result.
 */
export class ShipeasyProvider implements Provider {
  readonly metadata = { name: "shipeasy" } as const;
  readonly runsOn = "client" as const;

  constructor(private readonly client: Engine) {}

  /** Identify with the initial static context so the first read is warm. */
  async initialize(context?: EvaluationContext): Promise<void> {
    await this.client.identify(toUser(context));
  }

  /** Re-identify when the application author changes the static context. */
  async onContextChange(_old: EvaluationContext, next: EvaluationContext): Promise<void> {
    await this.client.identify(toUser(next));
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    _context: EvaluationContext,
    _logger?: Logger,
  ): ResolutionDetails<boolean> {
    const detail = this.client.getFlagDetail(flagKey);
    const m = mapFlagReason(detail.reason as ShipeasyFlagReason);
    if (m.errorCode) {
      return { value: defaultValue, reason: m.reason, errorCode: ERROR_CODE[m.errorCode] };
    }
    return { value: detail.value, reason: m.reason };
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    _context: EvaluationContext,
    _logger?: Logger,
  ): ResolutionDetails<string> {
    return resolveConfig(this.client.getConfig(flagKey), defaultValue, "string");
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    _context: EvaluationContext,
    _logger?: Logger,
  ): ResolutionDetails<number> {
    return resolveConfig(this.client.getConfig(flagKey), defaultValue, "number");
  }

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    _context: EvaluationContext,
    _logger?: Logger,
  ): ResolutionDetails<T> {
    return resolveConfig<T>(this.client.getConfig(flagKey), defaultValue, "object");
  }

  /** OpenFeature `track()` → Shipeasy `track()` (uses the identified user/anon). */
  track(trackingEventName: string, _context: EvaluationContext, details?: Record<string, unknown>): void {
    this.client.track(trackingEventName, details);
  }
}
