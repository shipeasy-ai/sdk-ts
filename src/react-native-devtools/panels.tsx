// Logged-in data panels: Gates / Configs / Experiments / Feedback. Read-only
// mirrors of the web overlay's panels — list the project's live state so a
// developer can verify what this device is being served.

import { FlatList, Text, View, StyleSheet } from "react-native";
import type { ReactNode } from "react";
import type { DevtoolsClient } from "../devtools/api";
import type { BugRecord, ConfigRecord, ExperimentRecord, GateRecord } from "../devtools/types";
import { useConfigs, useExperiments, useFeedback, useGates } from "./hooks";
import type { QueryState } from "./hooks";
import { Badge, ErrorState, Loading, Muted, Row, useTheme } from "./ui";

function PanelList<T>(props: {
  query: QueryState<T[]>;
  keyFor: (item: T) => string;
  render: (item: T) => ReactNode;
  emptyLabel: string;
}): ReactNode {
  const { query } = props;
  if (query.loading && !query.data) return <Loading />;
  if (query.error) return <ErrorState message={query.error} onRetry={query.refresh} />;
  const items = query.data ?? [];
  if (items.length === 0) {
    return (
      <View style={styles.empty}>
        <Muted>{props.emptyLabel}</Muted>
      </View>
    );
  }
  return (
    <FlatList
      data={items}
      keyExtractor={props.keyFor}
      renderItem={({ item }) => <>{props.render(item)}</>}
      refreshing={query.loading}
      onRefresh={query.refresh}
      contentContainerStyle={styles.list}
    />
  );
}

function NameCell(props: { name: string; sub?: string }): ReactNode {
  const t = useTheme();
  return (
    <View style={styles.nameCell}>
      <Text numberOfLines={1} style={[styles.name, { color: t.fg }]}>
        {props.name}
      </Text>
      {props.sub ? <Muted>{props.sub}</Muted> : null}
    </View>
  );
}

export function GatesPanel(props: { client: DevtoolsClient }): ReactNode {
  const query = useGates(props.client);
  return (
    <PanelList<GateRecord>
      query={query}
      keyFor={(g) => g.id}
      emptyLabel="No feature gates yet."
      render={(g) => (
        <Row>
          <NameCell name={g.name} sub={`${g.rolloutPct / 100}% rollout`} />
          <Badge
            label={g.enabled ? "enabled" : "disabled"}
            tone={g.enabled ? "ok" : "muted"}
          />
        </Row>
      )}
    />
  );
}

export function ConfigsPanel(props: { client: DevtoolsClient }): ReactNode {
  const query = useConfigs(props.client);
  return (
    <PanelList<ConfigRecord>
      query={query}
      keyFor={(c) => c.id}
      emptyLabel="No dynamic configs yet."
      render={(c) => {
        const preview = JSON.stringify(c.valueJson ?? {});
        return (
          <Row>
            <NameCell
              name={c.name}
              sub={preview.length > 60 ? `${preview.slice(0, 60)}…` : preview}
            />
          </Row>
        );
      }}
    />
  );
}

export function ExperimentsPanel(props: { client: DevtoolsClient }): ReactNode {
  const query = useExperiments(props.client);
  return (
    <PanelList<ExperimentRecord>
      query={query}
      keyFor={(e) => e.id}
      emptyLabel="No experiments yet."
      render={(e) => (
        <Row>
          <NameCell
            name={e.name}
            sub={`${e.universe} · ${e.groups.map((g) => g.name).join(" / ") || "no groups"}`}
          />
          <Badge
            label={e.status}
            tone={e.status === "running" ? "ok" : e.status === "draft" ? "accent" : "muted"}
          />
        </Row>
      )}
    />
  );
}

export function FeedbackPanel(props: { client: DevtoolsClient }): ReactNode {
  const query = useFeedback(props.client);
  return (
    <PanelList<BugRecord>
      query={query}
      keyFor={(b) => b.id}
      emptyLabel="No bugs in the queue."
      render={(b) => (
        <Row>
          <NameCell name={b.title} sub={b.reporterEmail ?? undefined} />
          <Badge
            label={b.status.replace(/_/g, " ")}
            tone={
              b.status === "resolved" ? "ok" : b.status === "pending_approval" ? "accent" : "muted"
            }
          />
        </Row>
      )}
    />
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: "center", padding: 32 },
  list: { paddingBottom: 24 },
  name: { fontSize: 15, fontWeight: "600" },
  nameCell: { flex: 1, gap: 2, marginRight: 8 },
});
