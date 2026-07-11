// Feedback panel — bugs + feature requests, at parity with the web overlay's:
// two sub-tabs, Active/All status filter, a detail view with inline status /
// priority editing, attachment previews (authed blob → data URI), image
// attachment upload (optional expo-image-picker), and the create forms.

import { useEffect, useState } from "react";
import { FlatList, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import type { DevtoolsClient } from "../devtools/api";
import type {
  AttachmentRecord,
  BugPriority,
  BugRecord,
  BugStatus,
  FeatureRequestRecord,
} from "../devtools/types";
import { useBugDetail, useFeatureDetail, useFeatureRequests, useFeedback } from "./hooks";
import { pickImageAttachment, getImagePicker } from "./expo-adapters";
import { BugForm } from "./bug-form";
import { FeatureForm } from "./feature-form";
import type { DevtoolsConfig } from "./hooks";
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

const STATUSES: BugStatus[] = [
  "open",
  "pending_approval",
  "triaged",
  "in_progress",
  "ready_for_qa",
  "resolved",
  "wont_fix",
];
const TERMINAL: ReadonlySet<BugStatus> = new Set(["resolved", "wont_fix"]);
const PRIORITIES: BugPriority[] = ["nice_to_have", "medium", "high", "critical"];

function statusTone(s: BugStatus): "ok" | "muted" | "accent" | "danger" {
  if (s === "resolved") return "ok";
  if (s === "wont_fix") return "muted";
  if (s === "pending_approval") return "accent";
  return "accent";
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
  kind: "bug" | "feature_request";
  id: string;
  onBack: () => void;
}): ReactNode {
  const t = useTheme();
  const { client, kind, id } = props;
  const bugQuery = useBugDetail(client, kind === "bug" ? id : null);
  const featureQuery = useFeatureDetail(client, kind === "feature_request" ? id : null);
  const query = kind === "bug" ? bugQuery : featureQuery;
  const [mutating, setMutating] = useState(false);
  const [mutateError, setMutateError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  if (query.loading && !query.data) return <Loading />;
  if (query.error) return <ErrorState message={query.error} onRetry={query.refresh} />;
  const item = query.data;
  if (!item) return null;

  const patch = async (p: { status?: BugStatus; priority?: BugPriority }) => {
    setMutating(true);
    setMutateError(null);
    try {
      if (kind === "bug") await client.updateBug(id, p);
      else await client.updateFeatureRequest(id, p);
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
      if (picked) {
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

  const bug = kind === "bug" ? bugQuery.data : null;
  const feature = kind === "feature_request" ? featureQuery.data : null;
  const pr = item.connectorData?.github?.pr;

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.detailScroll}>
      <Text style={[styles.detailBack, { color: t.accent }]} onPress={props.onBack}>
        ‹ Back
      </Text>
      <Text style={[styles.detailTitle, { color: t.fg }]} selectable>
        {item.title}
      </Text>
      <View style={styles.detailBadges}>
        <Badge label={label(item.status)} tone={statusTone(item.status)} />
        {item.priority ? <Badge label={label(item.priority)} tone="accent" /> : null}
      </View>

      {item.reporterEmail ? <KV k="reporter" v={item.reporterEmail} /> : null}
      {item.pageUrl ? <KV k="page" v={item.pageUrl} /> : null}
      <KV k="created" v={timeAgo(Date.now(), item.createdAt)} />
      {pr ? <KV k="linked PR" v={`#${pr.number} · ${pr.url}`} accent /> : null}

      {bug ? (
        <>
          {bug.actualResult ? (
            <>
              <SectionLabel>What happened</SectionLabel>
              <Muted>{bug.actualResult}</Muted>
            </>
          ) : null}
          {bug.stepsToReproduce ? (
            <>
              <SectionLabel>Steps to reproduce</SectionLabel>
              <Muted>{bug.stepsToReproduce}</Muted>
            </>
          ) : null}
          {bug.expectedResult ? (
            <>
              <SectionLabel>Expected</SectionLabel>
              <Muted>{bug.expectedResult}</Muted>
            </>
          ) : null}
        </>
      ) : null}
      {feature ? (
        <>
          {feature.description ? (
            <>
              <SectionLabel>Description</SectionLabel>
              <Muted>{feature.description}</Muted>
            </>
          ) : null}
          {feature.useCase ? (
            <>
              <SectionLabel>Use case</SectionLabel>
              <Muted>{feature.useCase}</Muted>
            </>
          ) : null}
        </>
      ) : null}

      {item.attachments.length > 0 || getImagePicker() ? (
        <>
          <SectionLabel hint={uploading ? "uploading…" : undefined}>Attachments</SectionLabel>
          <View style={styles.thumbRow}>
            {item.attachments.map((att) => (
              <AttachmentThumb key={att.id} client={client} att={att} />
            ))}
            {getImagePicker() ? (
              <Chip label={uploading ? "…" : "+ Attach"} onPress={() => void attach()} />
            ) : null}
          </View>
        </>
      ) : null}

      <SectionLabel hint={mutating ? "saving…" : undefined}>Status</SectionLabel>
      <ChipRow>
        {STATUSES.map((s) => (
          <Chip key={s} label={label(s)} selected={item.status === s} onPress={() => void patch({ status: s })} />
        ))}
      </ChipRow>
      <SectionLabel>Priority</SectionLabel>
      <ChipRow>
        {PRIORITIES.map((p) => (
          <Chip key={p} label={label(p)} selected={item.priority === p} onPress={() => void patch({ priority: p })} />
        ))}
      </ChipRow>
      {mutateError ? (
        <Text style={[styles.error, { color: t.danger }]}>{mutateError}</Text>
      ) : null}
    </ScrollView>
  );
}

// ── list + panel ─────────────────────────────────────────────────────────────

type Sub = "bugs" | "features";
type View_ = { name: "list" } | { name: "detail"; id: string } | { name: "create" };

export function FeedbackPanel(props: {
  client: DevtoolsClient;
  config: DevtoolsConfig;
  bugContext?: Record<string, unknown>;
}): ReactNode {
  const [sub, setSub] = useState<Sub>("bugs");
  const [view, setView] = useState<View_>({ name: "list" });
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState("");
  const bugsQuery = useFeedback(props.client);
  const featuresQuery = useFeatureRequests(props.client);
  const query = sub === "bugs" ? bugsQuery : featuresQuery;

  if (view.name === "detail") {
    return (
      <DetailView
        client={props.client}
        kind={sub === "bugs" ? "bug" : "feature_request"}
        id={view.id}
        onBack={() => {
          setView({ name: "list" });
          query.refresh();
        }}
      />
    );
  }

  if (view.name === "create") {
    const done = () => {
      setView({ name: "list" });
      props.client.invalidate();
      query.refresh();
    };
    return sub === "bugs" ? (
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
  const items: Array<BugRecord | FeatureRequestRecord> = (query.data ?? []).filter((it) => {
    if (!showAll && TERMINAL.has(it.status)) return false;
    if (needle && !it.title.toLowerCase().includes(needle)) return false;
    return true;
  });

  return (
    <View style={styles.fill}>
      <ChipRow>
        <Chip label="Bugs" selected={sub === "bugs"} onPress={() => setSub("bugs")} />
        <Chip label="Features" selected={sub === "features"} onPress={() => setSub("features")} />
        <Chip label={showAll ? "All" : "Active"} onPress={() => setShowAll((s) => !s)} />
        <Chip
          label={sub === "bugs" ? "+ New bug" : "+ New request"}
          onPress={() => setView({ name: "create" })}
        />
      </ChipRow>
      <SearchInput value={search} onChangeText={setSearch} />
      {query.loading && !query.data ? (
        <Loading />
      ) : query.error ? (
        <ErrorState message={query.error} onRetry={query.refresh} />
      ) : items.length === 0 ? (
        <View style={styles.empty}>
          <Muted>
            {needle
              ? "No matches."
              : sub === "bugs"
                ? "No bugs in the queue."
                : "No feature requests yet."}
          </Muted>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it.id}
          refreshing={query.loading}
          onRefresh={query.refresh}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <FeedbackRow item={item} onPress={() => setView({ name: "detail", id: item.id })} />
          )}
        />
      )}
    </View>
  );
}

function FeedbackRow(props: {
  item: BugRecord | FeatureRequestRecord;
  onPress: () => void;
}): ReactNode {
  const t = useTheme();
  const { item } = props;
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [styles.rowWrap, { opacity: pressed ? 0.85 : 1 }]}
    >
      <View style={[styles.row, { backgroundColor: t.surface, borderColor: t.border, borderRadius: t.radius }]}>
        <View style={styles.rowMain}>
          <Text numberOfLines={1} style={[styles.rowTitle, { color: t.fg }]}>
            {item.title}
          </Text>
          <Muted numberOfLines={1}>
            {[item.reporterEmail, timeAgo(Date.now(), item.createdAt)].filter(Boolean).join(" · ")}
          </Muted>
        </View>
        <Badge label={label(item.status)} tone={statusTone(item.status)} />
        {item.priority ? <Badge label={label(item.priority)} tone="accent" /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  detailBack: { fontSize: 15, fontWeight: "600", marginBottom: 10 },
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
