// Logged-in release panels: Gates / Configs / Experiments. Feature parity with
// the web overlay's panels, adapted to the platform: live values come from the
// engine bridge, and overrides drive the Engine's programmatic override store
// (applied live — React Native has no URL to write ?se_ks_* params to, so the
// web overlay's param+reload flow becomes bridge.setFlagOverride() etc.).

import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import type { DevtoolsClient } from "../devtools/api";
import type { ConfigRecord, ExperimentRecord, GateRecord } from "../devtools/types";
import type { DevtoolsEngineBridge } from "../devtools/bridge";
import { buildGateFlow, evalStepMatch, ruleSummary } from "../devtools/gate-flow";
import type { GateFlowStep, StepSource } from "../devtools/gate-flow";
import {
  useArchivedExperiments,
  useConfigs,
  useEngineBridge,
  useExperiments,
  useGates,
} from "./hooks";
import type { QueryState } from "./hooks";
import type { DevtoolsTheme } from "./theme";
import {
  Badge,
  Chip,
  ChipRow,
  ErrorState,
  Loading,
  Muted,
  Row,
  SearchInput,
  SectionLabel,
  Toggle,
  useTheme,
} from "./ui";

export function PanelList<T>(props: {
  query: QueryState<T[]>;
  keyFor: (item: T) => string;
  render: (item: T) => ReactNode;
  emptyLabel: string;
  /** Case-insensitive match against the search text; omit to hide the box. */
  matches?: (item: T, needle: string) => boolean;
  header?: ReactNode;
}): ReactNode {
  const { query } = props;
  const [search, setSearch] = useState("");
  if (query.loading && !query.data) return <Loading />;
  if (query.error) return <ErrorState message={query.error} onRetry={query.refresh} />;
  const needle = search.trim().toLowerCase();
  const items = (query.data ?? []).filter(
    (it) => !needle || !props.matches || props.matches(it, needle),
  );
  return (
    <View style={styles.fill}>
      {props.matches ? <SearchInput value={search} onChangeText={setSearch} /> : null}
      {props.header}
      {items.length === 0 ? (
        <View style={styles.empty}>
          <Muted>{needle ? "No matches." : props.emptyLabel}</Muted>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={props.keyFor}
          renderItem={({ item }) => <>{props.render(item)}</>}
          refreshing={query.loading}
          onRefresh={query.refresh}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
        />
      )}
    </View>
  );
}

export function NameCell(props: { name: string; sub?: string }): ReactNode {
  const t = useTheme();
  return (
    <View style={styles.nameCell}>
      <Text numberOfLines={1} style={[styles.name, { color: t.fg }]}>
        {props.name}
      </Text>
      {props.sub ? <Muted numberOfLines={1}>{props.sub}</Muted> : null}
    </View>
  );
}

/** Hint rendered under override controls when the host app hasn't configured
 *  the client SDK — there is no engine to force values on. */
function NoBridgeHint(): ReactNode {
  return (
    <Muted style={styles.noBridge}>
      Live values and forcing need the app to configure the Shipeasy client SDK.
    </Muted>
  );
}

// ── Gates ────────────────────────────────────────────────────────────────────

/** Left-stripe colour by rule source — mirrors the dashboard's gate-flow
 *  palette (user=accent, request-attr=purple, whitelist=cyan, public=muted). */
function stripeColor(source: StepSource, t: DevtoolsTheme): string {
  switch (source) {
    case "user":
      return t.accent;
    case "auto":
      return "#c084fc";
    case "whitelist":
      return "#22d3ee";
    case "public":
      return t.border;
  }
}

/** One node of the gate's evaluation flow: a source stripe, the step title +
 *  its pass/fail-for-this-user (conditions) or rollout % (rollout/whitelist),
 *  and a one-line predicate summary. */
function FlowStepRow(props: {
  step: GateFlowStep;
  user: Record<string, unknown> | null;
}): ReactNode {
  const t = useTheme();
  const { step } = props;
  const match = evalStepMatch(step, props.user);
  const pct = Math.round(step.rolloutPct / 100);
  const partial = step.type === "condition" && !step.whitelist && pct < 100;
  return (
    <View style={styles.step}>
      <View style={[styles.stepStripe, { backgroundColor: stripeColor(step.source, t) }]} />
      <View style={styles.stepBody}>
        <View style={styles.stepTop}>
          <Text style={[styles.stepTitle, { color: t.fg }]} numberOfLines={1}>
            {step.title}
          </Text>
          {match === "pass" ? (
            <Badge label="pass" tone="ok" />
          ) : match === "fail" ? (
            <Badge label="fail" tone="danger" />
          ) : step.whitelist ? (
            <Text style={[styles.stepPct, { color: t.accent }]}>always</Text>
          ) : (
            <Text style={[styles.stepPct, { color: pct === 0 ? t.fgMuted : t.fg }]}>{pct}%</Text>
          )}
          {partial ? (
            <Text style={[styles.stepPct, { color: t.fgMuted }]}>{pct}%</Text>
          ) : null}
        </View>
        <Text style={[styles.stepSummary, { color: t.fgMuted }]} numberOfLines={2}>
          {ruleSummary(step)}
        </Text>
      </View>
    </View>
  );
}

function GateRow(props: { gate: GateRecord; bridge: DevtoolsEngineBridge | null }): ReactNode {
  const t = useTheme();
  const { gate, bridge } = props;
  const [open, setOpen] = useState(false);
  const live = bridge ? bridge.getFlag(gate.name) : null;
  const override = bridge ? (bridge.getOverrides().flags[gate.name] ?? null) : null;
  const forced = override !== null;
  const effectiveOn = forced ? (override as boolean) : (live ?? false);
  const user = bridge ? bridge.getUser() : null;
  const flow = useMemo(() => buildGateFlow(gate), [gate]);

  return (
    <Row>
      <View style={styles.fill}>
        <View style={styles.rowTop}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gate.name}
            onPress={() => setOpen((o) => !o)}
            style={styles.fill}
          >
            <NameCell
              name={gate.name}
              sub={`${gate.rolloutPct / 100}% public${gate.killswitch ? " · killswitch" : ""}`}
            />
          </Pressable>
          {forced ? <Badge label="forced" tone="accent" /> : null}
          {bridge ? (
            <Toggle
              value={effectiveOn}
              onValueChange={(v) => bridge.setFlagOverride(gate.name, v)}
              accessibilityLabel={`${gate.name} on/off`}
            />
          ) : (
            <Badge label={gate.enabled ? "enabled" : "disabled"} tone={gate.enabled ? "ok" : "muted"} />
          )}
        </View>
        {open ? (
          <View style={styles.detail}>
            <View style={styles.served}>
              <Text style={[styles.servedLabel, { color: t.fgMuted }]}>Served to you</Text>
              <Badge label={effectiveOn ? "ON" : "OFF"} tone={effectiveOn ? "ok" : "muted"} />
              <Muted>
                {forced ? "· forced override" : live !== null ? "· live evaluation" : "· not evaluated"}
              </Muted>
            </View>

            <SectionLabel hint="first match wins">Evaluation flow</SectionLabel>
            {flow.map((s) => (
              <FlowStepRow key={s.key} step={s} user={user} />
            ))}

            {!bridge ? (
              <NoBridgeHint />
            ) : forced ? (
              <ChipRow>
                <Chip label="Clear override" onPress={() => bridge.removeOverride("flag", gate.name)} />
              </ChipRow>
            ) : null}
          </View>
        ) : null}
      </View>
    </Row>
  );
}

export function GatesPanel(props: { client: DevtoolsClient }): ReactNode {
  const query = useGates(props.client);
  const bridge = useEngineBridge();
  return (
    <PanelList<GateRecord>
      query={query}
      keyFor={(g) => g.id}
      emptyLabel="No feature gates yet."
      matches={(g, n) => g.name.toLowerCase().includes(n)}
      render={(g) => <GateRow gate={g} bridge={bridge} />}
    />
  );
}

// ── Configs ──────────────────────────────────────────────────────────────────

/** A config list row — a navigational entry that drills into the full-page
 *  nested viewer (ConfigViewerScreen). Shows a compact value preview + whether
 *  a local override is active. */
function ConfigRow(props: {
  config: ConfigRecord;
  bridge: DevtoolsEngineBridge | null;
  onOpen: (c: ConfigRecord) => void;
}): ReactNode {
  const t = useTheme();
  const { config, bridge } = props;
  const overrides = bridge ? bridge.getOverrides().configs : {};
  const forced = Object.prototype.hasOwnProperty.call(overrides, config.name);
  const live = bridge ? bridge.getConfig(config.name) : undefined;
  const effective = forced ? overrides[config.name] : live !== undefined ? live : config.valueJson;
  const preview = JSON.stringify(effective ?? {});
  return (
    <Row onPress={() => props.onOpen(config)}>
      <View style={styles.rowTop}>
        <NameCell
          name={config.name}
          sub={preview.length > 60 ? `${preview.slice(0, 60)}…` : preview}
        />
        {forced ? <Badge label="override" tone="accent" /> : null}
        <Text style={[styles.chevron, { color: t.fgMuted }]}>›</Text>
      </View>
    </Row>
  );
}

export function ConfigsPanel(props: {
  client: DevtoolsClient;
  onOpen: (c: ConfigRecord) => void;
}): ReactNode {
  const query = useConfigs(props.client);
  const bridge = useEngineBridge();
  return (
    <PanelList<ConfigRecord>
      query={query}
      keyFor={(c) => c.id}
      emptyLabel="No dynamic configs yet."
      matches={(c, n) => c.name.toLowerCase().includes(n)}
      render={(c) => <ConfigRow config={c} bridge={bridge} onOpen={props.onOpen} />}
    />
  );
}

// ── Experiments ──────────────────────────────────────────────────────────────

/** An experiment list row — a navigational entry that drills into the full-page
 *  detail screen (ExperimentDetailScreen). Shows the universe + variant count
 *  and the caller's live/forced assignment at a glance. */
function ExperimentRow(props: {
  experiment: ExperimentRecord;
  bridge: DevtoolsEngineBridge | null;
  onOpen: (e: ExperimentRecord) => void;
}): ReactNode {
  const t = useTheme();
  const { experiment: e, bridge } = props;
  const liveEntry = bridge ? bridge.getExperiment(e.name) : null;
  const forcedGroup = bridge ? (bridge.getOverrides().experiments[e.name] ?? null) : null;
  const effectiveGroup = forcedGroup ?? (liveEntry?.inExperiment ? liveEntry.group : null);
  return (
    <Row onPress={() => props.onOpen(e)}>
      <View style={styles.rowTop}>
        <NameCell
          name={e.name}
          sub={`${e.universe} · ${e.groups.length} variant${e.groups.length === 1 ? "" : "s"}`}
        />
        {forcedGroup ? (
          <Badge label={`forced: ${forcedGroup}`} tone="accent" />
        ) : effectiveGroup ? (
          <Badge label={effectiveGroup} tone="ok" />
        ) : null}
        <Badge
          label={e.status}
          tone={e.status === "running" ? "ok" : e.status === "draft" ? "accent" : "muted"}
        />
        <Text style={[styles.chevron, { color: t.fgMuted }]}>›</Text>
      </View>
    </Row>
  );
}

// Experiments are grouped by lifecycle status, each section showing a count
// badge. Running is open by default; the rest are folded (their rows stay
// unmounted until expanded). "stopped" is the paused/disabled bucket. Counts
// load upfront: one call for running/draft/stopped, one for the archive tab.
const EXPERIMENT_SECTIONS: Array<{ status: ExperimentRecord["status"]; label: string }> = [
  { status: "running", label: "Running" },
  { status: "draft", label: "Draft" },
  { status: "stopped", label: "Stopped" },
  { status: "archived", label: "Archived" },
];

function ExperimentSection(props: {
  bridge: DevtoolsEngineBridge | null;
  label: string;
  items: ExperimentRecord[];
  loading: boolean;
  defaultOpen: boolean;
  onOpen: (e: ExperimentRecord) => void;
}): ReactNode {
  const t = useTheme();
  const [open, setOpen] = useState(props.defaultOpen);
  const { items, loading } = props;
  return (
    <View style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={props.label}
        onPress={() => setOpen((o) => !o)}
        style={styles.sectionHeader}
      >
        <Text style={[styles.sectionCaret, { color: t.fgMuted }]}>{open ? "▾" : "▸"}</Text>
        <Text style={[styles.sectionTitle, { color: t.fg }]}>{props.label}</Text>
        {loading ? (
          <ActivityIndicator size="small" color={t.accent} />
        ) : (
          <View style={[styles.sectionCount, { backgroundColor: t.accentSoft }]}>
            <Text style={[styles.sectionCountText, { color: t.accent }]}>{items.length}</Text>
          </View>
        )}
      </Pressable>
      {open ? (
        items.length === 0 ? (
          <Muted style={styles.sectionEmpty}>
            {loading ? "Loading…" : `No ${props.label.toLowerCase()} experiments.`}
          </Muted>
        ) : (
          items.map((e) => (
            <ExperimentRow key={e.id} experiment={e} bridge={props.bridge} onOpen={props.onOpen} />
          ))
        )
      ) : null}
    </View>
  );
}

export function ExperimentsPanel(props: {
  client: DevtoolsClient;
  onOpen: (e: ExperimentRecord) => void;
}): ReactNode {
  const bridge = useEngineBridge();
  const active = useExperiments(props.client);
  const archived = useArchivedExperiments(props.client);
  const source = (status: ExperimentRecord["status"]) =>
    status === "archived" ? archived : active;

  if (active.error) return <ErrorState message={active.error} onRetry={active.refresh} />;

  return (
    <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
      {EXPERIMENT_SECTIONS.map((s) => {
        const q = source(s.status);
        return (
          <ExperimentSection
            key={s.status}
            bridge={bridge}
            label={s.label}
            items={(q.data ?? []).filter((e) => e.status === s.status)}
            loading={q.loading && !q.data}
            defaultOpen={s.status === "running"}
            onOpen={props.onOpen}
          />
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  chevron: { fontSize: 22, fontWeight: "400" },
  detail: { marginTop: 10 },
  empty: { alignItems: "center", padding: 32 },
  fill: { flex: 1 },
  list: { paddingBottom: 24 },
  name: { fontSize: 15, fontWeight: "600" },
  nameCell: { flex: 1, gap: 2, marginRight: 8 },
  noBridge: { marginTop: 4 },
  rowTop: { alignItems: "center", flexDirection: "row", gap: 8 },
  section: { marginBottom: 4 },
  sectionCaret: { fontSize: 12, width: 14 },
  sectionCount: { borderRadius: 999, minWidth: 20, paddingHorizontal: 6, paddingVertical: 1 },
  sectionCountText: { fontSize: 11, fontWeight: "700", textAlign: "center" },
  sectionEmpty: { paddingBottom: 8, paddingLeft: 22 },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    paddingVertical: 10,
  },
  sectionTitle: { flex: 1, fontSize: 13, fontWeight: "700", letterSpacing: 0.3 },
  served: { alignItems: "center", flexDirection: "row", gap: 6, marginBottom: 4 },
  servedLabel: { fontSize: 12 },
  step: { flexDirection: "row", gap: 8, marginBottom: 6 },
  stepBody: { flex: 1, gap: 1 },
  stepPct: { fontSize: 11.5, fontVariant: ["tabular-nums"], fontWeight: "600" },
  stepStripe: { borderRadius: 999, width: 3 },
  stepSummary: { fontSize: 11.5 },
  stepTitle: { flex: 1, fontSize: 13, fontWeight: "600" },
  stepTop: { alignItems: "center", flexDirection: "row", gap: 6 },
});
