// The bug report form — react-hook-form over the GENERATED zod schema (the
// same field contract the web overlay validates with), submitting through the
// public /cli/report intake when logged out (client key) or the full authed
// /api/admin/ops path when a devtools session exists.

import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { Controller } from "react-hook-form";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
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

/** `<Field>` bound to a react-hook-form control. Shared by the bug and
 *  feature forms (string-valued fields only). */
export function ControlledField<T extends FieldValues>(props: {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  autoCapitalize?: "none" | "sentences";
  keyboardType?: "default" | "email-address";
}): ReactNode {
  return (
    <Controller
      control={props.control}
      name={props.name}
      render={({ field, fieldState }) => (
        <Field
          label={props.label}
          value={typeof field.value === "string" ? field.value : ""}
          onChangeText={field.onChange}
          onBlur={field.onBlur}
          placeholder={props.placeholder}
          error={fieldState.error?.message}
          multiline={props.multiline}
          autoCapitalize={props.autoCapitalize}
          keyboardType={props.keyboardType}
        />
      )}
    />
  );
}

export function BugForm(props: {
  config: DevtoolsConfig;
  client: DevtoolsClient | null;
  context?: Record<string, unknown>;
  onDone: () => void;
}): ReactNode {
  const t = useTheme();
  const { form, ...state } = useBugForm({
    config: props.config,
    client: props.client,
    context: { ...defaultContext(), ...props.context },
  });

  if (state.result) {
    return (
      <View style={styles.done}>
        <Title>Thanks — bug filed</Title>
        <Muted style={styles.doneDetail}>
          {state.result.number !== undefined
            ? state.result.deduped
              ? `Matched existing report #${state.result.number}.`
              : `Filed as report #${state.result.number}. It'll be reviewed shortly.`
            : "Your report was filed."}
        </Muted>
        <Button title="Done" onPress={props.onDone} style={styles.doneButton} />
      </View>
    );
  }

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
      <ControlledField
        control={form.control}
        name="title"
        label="Title"
        placeholder="One-line summary"
      />
      <ControlledField
        control={form.control}
        name="actualResult"
        label="What happened?"
        placeholder="The error or wrong behaviour you saw"
        multiline
      />
      <ControlledField
        control={form.control}
        name="stepsToReproduce"
        label="Steps to reproduce"
        placeholder={"1. Open …\n2. Tap …"}
        multiline
      />
      <ControlledField
        control={form.control}
        name="reporterEmail"
        label="Your email (optional)"
        placeholder="So we can follow up"
        autoCapitalize="none"
        keyboardType="email-address"
      />
      {state.submitError ? (
        <Text style={[styles.submitError, { color: t.danger }]}>{state.submitError}</Text>
      ) : null}
      <Button
        title="Submit bug report"
        onPress={() => void state.submit()}
        loading={state.submitting}
        disabled={state.publicDisabled}
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
