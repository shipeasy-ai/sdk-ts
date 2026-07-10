// Translations panel — profile selector + searchable key list + per-key value
// editing applied straight to the profile (the web overlay's "Apply changes"
// path, via the shared core's updateKeyById). The web overlay's in-page
// click-to-edit mode is DOM-only (it rewrites rendered markers) and has no RN
// equivalent — editing here is per-key from the list instead.

import { useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import type { DevtoolsClient } from "../devtools/api";
import type { KeyRecord } from "../devtools/types";
import { useI18nKeys, useProfiles } from "./hooks";
import {
  Chip,
  ChipRow,
  ErrorState,
  Field,
  Loading,
  Muted,
  SearchInput,
  SectionLabel,
  useTheme,
} from "./ui";

function KeyRow(props: {
  client: DevtoolsClient;
  record: KeyRecord;
  onSaved: () => void;
}): ReactNode {
  const t = useTheme();
  const { record } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await props.client.updateKeyById(record.id, draft);
      setEditing(false);
      props.onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.keyRow, { borderBottomColor: t.border }]}>
      <Text style={[styles.key, { color: t.accent }]} numberOfLines={1} selectable>
        {record.key}
      </Text>
      {editing ? (
        <View>
          <Field
            label="Value"
            value={draft}
            onChangeText={setDraft}
            multiline
            autoCapitalize="none"
            error={error ?? undefined}
          />
          <ChipRow>
            <Chip label={saving ? "Saving…" : "Apply to profile"} selected onPress={() => void save()} />
            <Chip
              label="Cancel"
              onPress={() => {
                setDraft(record.value);
                setEditing(false);
              }}
            />
          </ChipRow>
        </View>
      ) : (
        <Text
          style={[styles.value, { color: t.fg }]}
          numberOfLines={2}
          onPress={() => setEditing(true)}
        >
          {record.value || "—"}
        </Text>
      )}
    </View>
  );
}

export function I18nPanel(props: { client: DevtoolsClient }): ReactNode {
  const profilesQuery = useProfiles(props.client);
  const [profileId, setProfileId] = useState<string | null>(null);
  const keysQuery = useI18nKeys(props.client, profileId);
  const [search, setSearch] = useState("");

  if (profilesQuery.loading && !profilesQuery.data) return <Loading />;
  if (profilesQuery.error) {
    return <ErrorState message={profilesQuery.error} onRetry={profilesQuery.refresh} />;
  }
  const profiles = profilesQuery.data ?? [];
  const activeProfile = profileId ?? profiles.find((p) => p.isDefault === 1)?.id ?? null;

  const needle = search.trim().toLowerCase();
  const keys = (keysQuery.data ?? []).filter(
    (k) => !needle || k.key.toLowerCase().includes(needle) || k.value.toLowerCase().includes(needle),
  );

  return (
    <View style={styles.fill}>
      {profiles.length > 0 ? (
        <>
          <SectionLabel>Profile</SectionLabel>
          <ChipRow>
            {profiles.map((p) => (
              <Chip
                key={p.id}
                label={p.isDefault === 1 ? `${p.name} · default` : p.name}
                selected={activeProfile === p.id}
                onPress={() => setProfileId(p.id)}
              />
            ))}
          </ChipRow>
        </>
      ) : null}
      <SearchInput value={search} onChangeText={setSearch} placeholder="Search keys…" />
      {keysQuery.loading && !keysQuery.data ? (
        <Loading />
      ) : keysQuery.error ? (
        <ErrorState message={keysQuery.error} onRetry={keysQuery.refresh} />
      ) : keys.length === 0 ? (
        <View style={styles.empty}>
          <Muted>{needle ? "No matching keys." : "No translation keys yet."}</Muted>
        </View>
      ) : (
        <FlatList
          data={keys}
          keyExtractor={(k) => k.id}
          refreshing={keysQuery.loading}
          onRefresh={keysQuery.refresh}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <KeyRow client={props.client} record={item} onSaved={keysQuery.refresh} />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: "center", padding: 32 },
  fill: { flex: 1 },
  key: { fontFamily: "Menlo", fontSize: 12, marginBottom: 4 },
  keyRow: { borderBottomWidth: 1, paddingVertical: 10 },
  list: { paddingBottom: 24 },
  value: { fontSize: 14 },
});
