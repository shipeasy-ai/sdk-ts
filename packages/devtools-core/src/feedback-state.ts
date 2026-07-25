// Derives the "what's the AI done with this ticket" state the feedback list
// tints rows by. Framework-agnostic (no DOM/React) — read off the ops item's
// `connectorData` (the full connector blob the admin list returns). All signals
// are tolerated absent: an item with no agent/PR activity returns null.

import type { FeedbackConnectorData } from "./types";

export type FeedbackAgentState =
  /** The linked PR merged — the fix landed. */
  | "pr_landed"
  /** The AI ran and posted a question back; waiting on a human reply. */
  | "question"
  /** The AI ran and opened a PR that's ready for review. */
  | "pr_ready";

export interface FeedbackAgentInfo {
  state: FeedbackAgentState;
  /** The linked PR, when the state is PR-related (for the row's PR link). */
  pr?: { number: number; url: string };
}

/** True when the connector PR object carries any merged marker. */
function prMerged(pr: NonNullable<NonNullable<FeedbackConnectorData["github"]>["pr"]>): boolean {
  return pr.merged === true || pr.state === "merged" || typeof pr.mergedAt === "string";
}

/** True when the agent trace says it's awaiting a human reply (question posted). */
function agentAwaitingReply(cd: FeedbackConnectorData | null | undefined): boolean {
  const a = cd?.agent;
  return a?.awaitingReply === true || a?.state === "awaiting_reply";
}

/**
 * The item's AI/PR state, or null when the AI hasn't produced a signal yet.
 * Precedence: a landed PR wins (terminal), then an open question, then a
 * ready-for-review PR.
 */
export function feedbackAgentInfo(item: {
  connectorData?: FeedbackConnectorData | null;
}): FeedbackAgentInfo | null {
  const pr = item.connectorData?.github?.pr ?? null;
  if (pr && prMerged(pr)) return { state: "pr_landed", pr: { number: pr.number, url: pr.url } };
  if (agentAwaitingReply(item.connectorData)) return { state: "question" };
  if (pr) return { state: "pr_ready", pr: { number: pr.number, url: pr.url } };
  return null;
}

/** Short row-badge label per state. */
export const FEEDBACK_AGENT_LABEL: Record<FeedbackAgentState, string> = {
  pr_landed: "merged",
  question: "needs reply",
  pr_ready: "PR ready",
};
