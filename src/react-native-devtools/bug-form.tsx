// The bug report form — the same field contract as the web overlay's bug form
// (generated zod schema), submitting through the public /cli/report intake
// when logged out (client key) or the full authed /api/admin/ops path when a
// devtools session exists.

import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import type { DevtoolsClient } from "../devtools/api";
import { useBugForm } from "./hooks";
import type { DevtoolsConfig } from "./hooks";
import { Button, Field, Muted, Title, useTheme } from "./ui";

/** Auto-attached system context (mirrors the web form's auto-captured
 *  pageUrl/userAgent — here it's the platform + app metadata the host gives). */
function defaultContext(): Record<string, unknown> {
  return {
    platform: Platform.OS,
    platform_version: String(Platform.Version),
    source: "rn-devtools",
  };
}

export function BugForm(props: {
  config: DevtoolsConfig;
  client: DevtoolsClient | null;
  context?: Record<string, unknown>;
  onDone: () => void;
}): ReactNode {
  const t = useTheme();
  const form = useBugForm({
    config: props.config,
    client: props.client,
    context: { ...defaultContext(), ...props.context },
  });

  if (form.result) {
    return (
      <View style={styles.done}>
        <Title>Thanks — bug filed</Title>
        <Muted style={styles.doneDetail}>
          {form.result.number !== undefined
            ? form.result.deduped
              ? `Matched existing report #${form.result.number}.`
              : `Filed as report #${form.result.number}. It'll be reviewed shortly.`
            : "Your report was filed."}
        </Muted>
        <Button title="Done" onPress={props.onDone} style={styles.doneButton} />
      </View>
    );
  }

  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
      <Field
        label="Title"
        value={str(form.values.title)}
        onChangeText={(v) => form.setField("title", v)}
        placeholder="One-line summary"
        error={form.errors.title}
      />
      <Field
        label="What happened?"
        value={str(form.values.actualResult)}
        onChangeText={(v) => form.setField("actualResult", v)}
        placeholder="The error or wrong behaviour you saw"
        error={form.errors.actualResult}
        multiline
      />
      <Field
        label="Steps to reproduce"
        value={str(form.values.stepsToReproduce)}
        onChangeText={(v) => form.setField("stepsToReproduce", v)}
        placeholder={"1. Open …\n2. Tap …"}
        error={form.errors.stepsToReproduce}
        multiline
      />
      <Field
        label="Your email (optional)"
        value={str(form.values.reporterEmail)}
        onChangeText={(v) => form.setField("reporterEmail", v)}
        placeholder="So we can follow up"
        error={form.errors.reporterEmail}
        autoCapitalize="none"
        keyboardType="email-address"
      />
      {form.submitError ? (
        <Text style={[styles.submitError, { color: t.danger }]}>{form.submitError}</Text>
      ) : null}
      <Button
        title="Submit bug report"
        onPress={() => void form.submit()}
        loading={form.submitting}
        disabled={form.publicDisabled}
      />
      <Button title="Cancel" variant="ghost" onPress={props.onDone} style={styles.cancel} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  cancel: { marginTop: 8 },
  done: { alignItems: "center", gap: 8, padding: 24 },
  doneButton: { alignSelf: "stretch", marginTop: 16 },
  doneDetail: { textAlign: "center" },
  form: { paddingBottom: 32 },
  submitError: { fontSize: 13, marginBottom: 10 },
});
