// Feedback panel — the project's ops queue: user-filed bugs + feature requests
// and the auto-filed error + alert tickets. Open items only (resolved / won't-
// fix are never listed), grouped into status sections. Rows carry a priority
// left-border and, when an agent has acted, an AI/PR state pill (the only
// badge). Tapping a row opens a detail with inline status / priority editing,
// attachment previews + upload (bug/feature), and the create forms.

import { useEffect, useRef, useState } from "react";
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import type { DevtoolsClient } from "../devtools/api";
import type {
  AttachmentRecord,
  BugPriority,
  BugRecord,
  BugStatus,
  FeatureRequestRecord,
  OpsItemType,
} from "../devtools/types";
import { feedbackAgentInfo, FEEDBACK_AGENT_LABEL } from "../devtools/feedback-state";
import type { FeedbackAgentState } from "../devtools/feedback-state";
import {
  useAlerts,
  useErrors,
  useFeatureRequests,
  useFeedback,
  useOpsDetail,
  useSheetNav,
} from "./hooks";
import type { QueryState } from "./hooks";
import { pickImageAttachment, getImagePicker } from "./expo-adapters";
import { BugForm } from "./bug-form";
import { FeatureForm } from "./feature-form";
import type { DevtoolsConfig } from "./hooks";
import type { DevtoolsTheme } from "./theme";
import {
  Badge,
  Chip,
  ChipRow,
  ErrorState,
  KV,
  Loading,
  Muted,
  SearchInput,
  SectionLabel,
  timeAgo,
  useTheme,
} from "./ui";

type OpsItem = BugRecord | FeatureRequestRecord;

const STATUSES: BugStatus[] = [
  "open",
  "pending_approval",
  "triaged",
  "in_progress",
  "ready_for_qa",
  "resolved",
  "wont_fix",
];
const TERMINAL: ReadonlySet<string> = new Set(["resolved", "wont_fix"]);
const PRIORITIES: BugPriority[] = ["nice_to_have", "medium", "high", "critical"];

// Workflow order the status sections render in; any status not listed is
// appended after these (keyed by its raw value).
const STATUS_ORDER = [
  "pending_approval",
  "triage",
  "triaged",
  "open",
  "in_progress",
  "ready_for_qa",
];

// The queue sub-tabs — bugs/features are user-fileable, errors/alerts are the
// auto-filed system tickets.
const SUBS: Array<{ kind: OpsItemType; label: string }> = [
  { kind: "bug", label: "Bugs" },
  { kind: "feature_request", label: "Features" },
  { kind: "error", label: "Errors" },
  { kind: "alert", label: "Alerts" },
];

function statusTone(s: string): "ok" | "muted" | "accent" | "danger" {
  if (s === "resolved") return "ok";
  if (s === "wont_fix") return "muted";
  return "accent";
}

/** Priority → the row's left-border colour. `nice_to_have` / unset read as the
 *  neutral border (no emphasis). */
function priorityTint(p: string | null | undefined, t: DevtoolsTheme): string {
  switch (p) {
    case "critical":
      return t.danger;
    case "high":
      return "#f97316";
    case "medium":
      return "#eab308";
    default:
      return t.border;
  }
}

function label(s: string): string {
  return s.replace(/_/g, " ");
}

// ── attachments ──────────────────────────────────────────────────────────────

function AttachmentThumb(props: { client: DevtoolsClient; att: AttachmentRecord }): ReactNode {
  const t = useTheme();
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isImage = props.att.mimeType.startsWith("image/");

  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    props.client
      .attachmentBlob(props.att.id)
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            // The stream route needs the Authorization header, which <Image>
            // can't send — materialize the bytes as a data URI instead.
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error("read failed"));
            reader.readAsDataURL(blob);
          }),
      )
      .then((uri) => {
        if (alive) setDataUri(uri);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [props.client, props.att.id, isImage]);

  if (isImage && dataUri) {
    return <Image source={{ uri: dataUri }} style={[styles.thumb, { borderColor: t.border }]} />;
  }
  return (
    <View style={[styles.thumb, styles.thumbFallback, { borderColor: t.border }]}>
      <Muted>{failed ? "!" : isImage ? "…" : props.att.kind}</Muted>
    </View>
  );
}

// ── detail ───────────────────────────────────────────────────────────────────

function DetailView(props: {
  client: DevtoolsClient;
  kind: OpsItemType;
  id: string;
}): ReactNode {
  const t = useTheme();
  const { client, kind, id } = props;
  const query = useOpsDetail(client, id);
  const [mutating, setMutating] = useState(false);
  const [mutateError, setMutateError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const editableContent = kind === "bug" || kind === "feature_request";

  if (query.loading && !query.data) return <Loading />;
  if (query.error) return <ErrorState message={query.error} onRetry={query.refresh} />;
  const item = query.data;
  if (!item) return null;

  const patch = async (p: { status?: BugStatus; priority?: BugPriority }) => {
    setMutating(true);
    setMutateError(null);
    try {
      await client.updateOps(id, p);
      query.refresh();
    } catch (e) {
      setMutateError(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setMutating(false);
    }
  };

  const attach = async () => {
    setUploading(true);
    setMutateError(null);
    try {
      const picked = await pickImageAttachment();
      if (picked && (kind === "bug" || kind === "feature_request")) {
        await client.uploadAttachment({
          reportKind: kind,
          reportId: id,
          kind: "screenshot",
          filename: picked.filename,
          blob: picked.blob,
        });
        client.invalidate();
        query.refresh();
      }
    } catch (e) {
      setMutateError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const isBug = kind === "bug";
  const isFeature = kind === "feature_request";
  const pr = item.connectorData?.github?.pr;

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.detailScroll}>
      <Text style={[styles.detailTitle, { color: t.fg }]} selectable>
        {item.title}
      </Text>
      <View style={styles.detailBadges}>
        <Badge label={label(item.status)} tone={statusTone(item.status)} />
        {item.priority ? <Badge label={label(item.priority)} tone="accent" /> : null}
      </View>

      <SectionLabel>Metadata</SectionLabel>
      <KV k="Type" v={label(kind)} />
      {item.reporterEmail ? <KV k="Reporter" v={item.reporterEmail} /> : null}
      {item.sourceRef ? <KV k="Source" v={item.sourceRef} /> : null}
      {item.pageUrl ? <KV k="Page" v={item.pageUrl} /> : null}
      <KV k="Created" v={new Date(item.createdAt).toLocaleString()} />
      {pr ? <KV k="Linked PR" v={`#${pr.number} · ${pr.url}`} accent /> : null}

      {isBug ? (
        <>
          {item.actualResult ? (
            <>
              <SectionLabel>What happened</SectionLabel>
              <Muted>{item.actualResult}</Muted>
            </>
          ) : null}
          {item.stepsToReproduce ? (
            <>
              <SectionLabel>Steps to reproduce</SectionLabel>
              <Muted>{item.stepsToReproduce}</Muted>
            </>
          ) : null}
          {item.expectedResult ? (
            <>
              <SectionLabel>Expected</SectionLabel>
              <Muted>{item.expectedResult}</Muted>
            </>
          ) : null}
        </>
      ) : null}
      {isFeature ? (
        <>
          {item.description ? (
            <>
              <SectionLabel>Description</SectionLabel>
              <Muted>{item.description}</Muted>
            </>
          ) : null}
          {item.useCase ? (
            <>
              <SectionLabel>Use case</SectionLabel>
              <Muted>{item.useCase}</Muted>
            </>
          ) : null}
        </>
      ) : null}
      {!editableContent ? (
        <Muted style={styles.autoNote}>
          Auto-filed {label(kind)} ticket — its content isn’t editable here.
        </Muted>
      ) : null}

      {(editableContent && (item.attachments.length > 0 || getImagePicker())) ||
      item.attachments.length > 0 ? (
        <>
          <SectionLabel hint={uploading ? "uploading…" : undefined}>Attachments</SectionLabel>
          <View style={styles.thumbRow}>
            {item.attachments.map((att) => (
              <AttachmentThumb key={att.id} client={client} att={att} />
            ))}
            {editableContent && getImagePicker() ? (
              <Chip label={uploading ? "…" : "+ Attach"} onPress={() => void attach()} />
            ) : null}
          </View>
        </>
      ) : null}

      <SectionLabel hint={mutating ? "saving…" : undefined}>Status</SectionLabel>
      <ChipRow>
        {STATUSES.map((s) => (
          <Chip
            key={s}
            label={label(s)}
            selected={item.status === s}
            onPress={() => void patch({ status: s })}
          />
        ))}
      </ChipRow>
      <SectionLabel>Priority</SectionLabel>
      <ChipRow>
        {PRIORITIES.map((p) => (
          <Chip
            key={p}
            label={label(p)}
            selected={item.priority === p}
            onPress={() => void patch({ priority: p })}
          />
        ))}
      </ChipRow>
      {mutateError ? (
        <Text style={[styles.error, { color: t.danger }]}>{mutateError}</Text>
      ) : null}
    </ScrollView>
  );
}

// ── list + panel ─────────────────────────────────────────────────────────────

type View_ = { name: "list" } | { name: "detail"; id: string } | { name: "create" };

// Header title for a detail screen — the item TYPE, never the (often long)
// item title, which won't fit the header.
const DETAIL_TITLE: Record<OpsItemType, string> = {
  bug: "Bug detail",
  feature_request: "Feature detail",
  error: "Error detail",
  alert: "Alert detail",
  measure_plan: "Ticket detail",
};

export function FeedbackPanel(props: {
  client: DevtoolsClient;
  config: DevtoolsConfig;
  bugContext?: Record<string, unknown>;
}): ReactNode {
  const [sub, setSub] = useState<OpsItemType>("bug");
  const [view, setView] = useState<View_>({ name: "list" });
  const [search, setSearch] = useState("");
  // Lazy per-tab loading — only the active tab hits the network (results stay
  // cached on the client, so switching back is instant).
  const bugsQuery = useFeedback(sub === "bug" ? props.client : null);
  const featuresQuery = useFeatureRequests(sub === "feature_request" ? props.client : null);
  const errorsQuery = useErrors(sub === "error" ? props.client : null);
  const alertsQuery = useAlerts(sub === "alert" ? props.client : null);
  const query: QueryState<OpsItem[]> =
    sub === "bug"
      ? bugsQuery
      : sub === "feature_request"
        ? featuresQuery
        : sub === "error"
          ? errorsQuery
          : alertsQuery;

  const canCreate = sub === "bug" || sub === "feature_request";

  // The header's single ‹ Back drives the internal list ↔ detail/create nav —
  // no per-screen back button. Register a Back handler (+ title) while nested.
  const nav = useSheetNav();
  const backToList = useRef<() => void>(() => {});
  backToList.current = () => {
    setView({ name: "list" });
    query.refresh();
  };
  useEffect(() => {
    if (!nav) return;
    const nested = view.name !== "list";
    nav.setBack(nested ? () => backToList.current() : null);
    nav.setTitle(
      view.name === "detail"
        ? DETAIL_TITLE[sub]
        : view.name === "create"
          ? sub === "bug"
            ? "New bug"
            : "New request"
          : null,
    );
    return () => {
      nav.setBack(null);
      nav.setTitle(null);
    };
  }, [nav, view, sub]);

  if (view.name === "detail") {
    return <DetailView client={props.client} kind={sub} id={view.id} />;
  }

  if (view.name === "create") {
    const done = () => {
      setView({ name: "list" });
      props.client.invalidate();
      query.refresh();
    };
    return sub === "bug" ? (
      <BugForm
        config={props.config}
        client={props.client}
        context={props.bugContext}
        onDone={done}
      />
    ) : (
      <FeatureForm
        config={props.config}
        client={props.client}
        context={props.bugContext}
        onDone={done}
      />
    );
  }

  const needle = search.trim().toLowerCase();
  // Resolved / won't-fix are never shown — the queue stays on open, actionable
  // items. What's left is grouped into status sections (the row no longer
  // carries a status badge).
  const items = (query.data ?? []).filter(
    (it) => !TERMINAL.has(it.status) && (!needle || it.title.toLowerCase().includes(needle)),
  );
  const byStatus = new Map<string, OpsItem[]>();
  for (const it of items) {
    const bucket = byStatus.get(it.status);
    if (bucket) bucket.push(it);
    else byStatus.set(it.status, [it]);
  }
  const orderedStatuses = [
    ...STATUS_ORDER.filter((s) => byStatus.has(s)),
    ...[...byStatus.keys()].filter((s) => !STATUS_ORDER.includes(s)),
  ];

  return (
    <View style={styles.fill}>
      <ChipRow>
        {SUBS.map((s) => (
          <Chip
            key={s.kind}
            label={s.label}
            selected={sub === s.kind}
            onPress={() => setSub(s.kind)}
          />
        ))}
      </ChipRow>
      <SearchInput value={search} onChangeText={setSearch} />
      {canCreate ? (
        <ChipRow>
          <Chip
            label={sub === "bug" ? "+ New bug" : "+ New request"}
            onPress={() => setView({ name: "create" })}
          />
        </ChipRow>
      ) : null}
      {query.loading && !query.data ? (
        <Loading />
      ) : query.error ? (
        <ErrorState message={query.error} onRetry={query.refresh} />
      ) : items.length === 0 ? (
        <View style={styles.empty}>
          <Muted>{needle ? "No matches." : "Nothing open here."}</Muted>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {orderedStatuses.map((status) => {
            const rows = byStatus.get(status) ?? [];
            return (
              <View key={status}>
                <SectionLabel hint={String(rows.length)}>{label(status)}</SectionLabel>
                {rows.map((item) => (
                  <FeedbackRow
                    key={item.id}
                    item={item}
                    onPress={() => setView({ name: "detail", id: item.id })}
                  />
                ))}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

/** Tint for a row's AI/PR state — cyan (PR ready for review), amber (a question
 *  is waiting on a human), green (the PR merged / fix landed). */
function agentTint(state: FeedbackAgentState, t: DevtoolsTheme): string {
  switch (state) {
    case "pr_ready":
      return "#22d3ee";
    case "question":
      return "#f59e0b";
    case "pr_landed":
      return t.ok;
  }
}

/** The AI/PR chip on a feedback row: a tappable PR link (opens the PR) for the
 *  PR states, or a plain "needs reply" pill for a posted-back question. */
function AgentChip(props: {
  info: NonNullable<ReturnType<typeof feedbackAgentInfo>>;
  color: string;
}): ReactNode {
  const { info, color } = props;
  if (info.pr) {
    const prefix = info.state === "pr_landed" ? "merged" : "PR";
    return (
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Pull request #${info.pr.number}`}
        onPress={() => void Linking.openURL(info.pr!.url)}
        style={[styles.agentChip, { borderColor: color }]}
      >
        <Text style={[styles.agentChipText, { color }]}>
          {prefix} #{info.pr.number} ↗
        </Text>
      </Pressable>
    );
  }
  return (
    <View style={[styles.agentChip, { borderColor: color }]}>
      <Text style={[styles.agentChipText, { color }]}>{FEEDBACK_AGENT_LABEL[info.state]}</Text>
    </View>
  );
}

function FeedbackRow(props: { item: OpsItem; onPress: () => void }): ReactNode {
  const t = useTheme();
  const { item } = props;
  const info = feedbackAgentInfo(item);
  const tint = info ? agentTint(info.state, t) : null;
  // Left border encodes priority; the AI/PR pill is the only badge.
  const meta = [item.reporterEmail, item.priority ? label(item.priority) : null, timeAgo(Date.now(), item.createdAt)]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [styles.rowWrap, { opacity: pressed ? 0.85 : 1 }]}
    >
      <View
        style={[
          styles.row,
          {
            backgroundColor: t.surface,
            borderColor: t.border,
            borderRadius: t.radius,
            borderLeftColor: priorityTint(item.priority, t),
            borderLeftWidth: 3,
          },
        ]}
      >
        <View style={styles.rowMain}>
          <Text numberOfLines={1} style={[styles.rowTitle, { color: t.fg }]}>
            {item.title}
          </Text>
          {meta ? <Muted numberOfLines={1}>{meta}</Muted> : null}
        </View>
        {info && tint ? <AgentChip info={info} color={tint} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  agentChip: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 2 },
  agentChipText: { fontSize: 10.5, fontWeight: "700" },
  autoNote: { marginTop: 10 },
  detailBadges: { flexDirection: "row", gap: 8, marginBottom: 12 },
  detailScroll: { paddingBottom: 32 },
  detailTitle: { fontSize: 17, fontWeight: "700", marginBottom: 8 },
  empty: { alignItems: "center", padding: 32 },
  error: { fontSize: 13, marginTop: 8 },
  fill: { flex: 1 },
  list: { paddingBottom: 24 },
  row: {
    alignItems: "center",
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  rowMain: { flex: 1, gap: 2, marginRight: 8 },
  rowTitle: { fontSize: 15, fontWeight: "600" },
  rowWrap: { marginBottom: 8 },
  thumb: { borderRadius: 6, borderWidth: 1, height: 64, width: 64 },
  thumbFallback: { alignItems: "center", justifyContent: "center" },
  thumbRow: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 4 },
});
