// Bug / feature-request form contract — ONE schema powering every submit path.
//
// The generated zod schemas (from the admin OpenAPI contract) are the single
// source of truth for field names, bounds, and requiredness — the same shapes
// the web devtools overlay validates with. The RN bug form validates against
// `bugFormSchema` and then submits through EITHER:
//   • `submitPublicBug` (public client key → /cli/report; no attachments,
//     no priority — the public endpoint doesn't take them), or
//   • `DevtoolsClient.createBug` (admin key → /api/admin/ops; full shape).

import type { z } from "zod";
import { zCreateBugRequest, zCreateFeatureRequestRequest } from "./generated/zod.gen";
import type { CreateBugRequestInput, CreateFeatureRequestRequestInput } from "./generated/zod.gen";
import type { PublicBugInput } from "./public-report";

export { zCreateBugRequest, zCreateFeatureRequestRequest };
export type { CreateBugRequestInput, CreateFeatureRequestRequestInput };

/** The editable bug-form fields (the `type` discriminator is injected at
 *  submit time; auto-captured context is layered on separately). */
export const bugFormSchema = zCreateBugRequest.omit({ type: true });
export type BugFormValues = Omit<CreateBugRequestInput, "type">;
/** Pre-parse shape (defaults not yet applied) — what a form editor holds. */
export type BugFormInput = z.input<typeof bugFormSchema>;

/** The editable feature-request-form fields. */
export const featureFormSchema = zCreateFeatureRequestRequest.omit({ type: true });
export type FeatureFormValues = Omit<CreateFeatureRequestRequestInput, "type">;
/** Pre-parse shape (defaults not yet applied) — what a form editor holds. */
export type FeatureFormInput = z.input<typeof featureFormSchema>;

/** Field-keyed validation errors (first issue per field), ready for inline
 *  display under each input. */
export type FormErrors<T> = Partial<Record<keyof T & string, string>>;

function firstIssuePerField<T>(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): FormErrors<T> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "");
    if (field && !(field in out)) out[field] = issue.message;
  }
  return out as FormErrors<T>;
}

/** Validate bug-form values. Returns `{ ok: true, value }` with parsed/defaulted
 *  values, or `{ ok: false, errors }` keyed by field for inline display. */
export function validateBugForm(
  values: unknown,
): { ok: true; value: BugFormValues } | { ok: false; errors: FormErrors<BugFormValues> } {
  const r = bugFormSchema.safeParse(values);
  if (r.success) return { ok: true, value: r.data as BugFormValues };
  return { ok: false, errors: firstIssuePerField<BugFormValues>(r.error) };
}

/** Validate feature-request-form values (same contract as {@link validateBugForm}). */
export function validateFeatureForm(
  values: unknown,
): { ok: true; value: FeatureFormValues } | { ok: false; errors: FormErrors<FeatureFormValues> } {
  const r = featureFormSchema.safeParse(values);
  if (r.success) return { ok: true, value: r.data as FeatureFormValues };
  return { ok: false, errors: firstIssuePerField<FeatureFormValues>(r.error) };
}

/** Project validated bug-form values onto the public `/cli/report` body shape
 *  (the public endpoint takes no attachments/priority/viewport; steps map to
 *  `description`, actual result maps to `error`). */
export function bugFormToPublicInput(
  value: BugFormValues,
  extra?: { step?: string; context?: Record<string, unknown> },
): PublicBugInput {
  return {
    title: value.title,
    ...(value.actualResult ? { error: value.actualResult } : {}),
    ...(value.stepsToReproduce ? { description: value.stepsToReproduce } : {}),
    ...(value.reporterEmail ? { reporterEmail: value.reporterEmail } : {}),
    ...(extra?.step ? { step: extra.step } : {}),
    ...(extra?.context ?? value.context
      ? { context: { ...(value.context ?? {}), ...(extra?.context ?? {}) } }
      : {}),
  };
}
