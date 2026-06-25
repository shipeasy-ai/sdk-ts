/**
 * OpenFeature **server** provider for Shipeasy.
 *
 * Lets apps standardized on the CNCF OpenFeature API plug Shipeasy in as the
 * backing provider:
 *
 * ```ts
 * import { OpenFeature } from "@openfeature/server-sdk";
 * import { Engine } from "@shipeasy/sdk/server";
 * import { ShipeasyProvider } from "@shipeasy/sdk/openfeature-server";
 *
 * const client = new Engine({ apiKey: process.env.SHIPEASY_SERVER_KEY! });
 * await OpenFeature.setProviderAndWait(new ShipeasyProvider(client));
 *
 * const ofClient = OpenFeature.getClient();
 * const on = await ofClient.getBooleanValue("new_checkout", false, { targetingKey: "u1" });
 * ```
 *
 * Pure adapter over `Engine` — no change to evaluation. `@openfeature/server-sdk`
 * is an optional peer dependency; install it in the consuming app.
 */
import type {
  EvaluationContext,
  JsonValue,
  Logger,
  Provider,
  ResolutionDetails,
} from "@openfeature/server-sdk";
import { ErrorCode } from "@openfeature/server-sdk";

import { Engine } from "../server/index";
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
 * Shipeasy OpenFeature provider (server paradigm). Wraps an `Engine`;
 * evaluation is local against the cached blob, so resolution is effectively
 * synchronous (the methods are `async` only to satisfy the server contract).
 */
export class ShipeasyProvider implements Provider {
  readonly metadata = { name: "shipeasy" } as const;
  readonly runsOn = "server" as const;

  constructor(private readonly client: Engine) {}

  /** Fetch the rules blob once. The SDK fires `Ready` when this resolves. */
  async initialize(): Promise<void> {
    await this.client.initOnce();
  }

  async onClose(): Promise<void> {
    this.client.destroy();
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    _logger?: Logger,
  ): Promise<ResolutionDetails<boolean>> {
    const detail = this.client.getFlagDetail(flagKey, toUser(context));
    const m = mapFlagReason(detail.reason as ShipeasyFlagReason);
    if (m.errorCode) {
      return {
        value: defaultValue,
        reason: m.reason,
        errorCode: ERROR_CODE[m.errorCode],
      };
    }
    return { value: detail.value, reason: m.reason };
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    _context: EvaluationContext,
    _logger?: Logger,
  ): Promise<ResolutionDetails<string>> {
    return resolveConfig(this.client.getConfig(flagKey), defaultValue, "string");
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    _context: EvaluationContext,
    _logger?: Logger,
  ): Promise<ResolutionDetails<number>> {
    return resolveConfig(this.client.getConfig(flagKey), defaultValue, "number");
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    _context: EvaluationContext,
    _logger?: Logger,
  ): Promise<ResolutionDetails<T>> {
    return resolveConfig<T>(this.client.getConfig(flagKey), defaultValue, "object");
  }

  /** OpenFeature `track()` → Shipeasy `track()`. No-ops without a targeting key. */
  track(trackingEventName: string, context: EvaluationContext, details?: Record<string, unknown>): void {
    const userId = context.targetingKey ?? (context.user_id as string | undefined);
    if (!userId) return;
    this.client.track(userId, trackingEventName, details);
  }
}
