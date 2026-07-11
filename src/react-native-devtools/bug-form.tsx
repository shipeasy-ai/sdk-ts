// The bug report form — react-hook-form over the GENERATED zod schema (the
// same field contract the web overlay validates with), submitting through the
// public /cli/report intake when logged out (client key) or the full authed
// /api/admin/ops path when a devtools session exists.

import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Controller } from "react-hook-form";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { useState } from "react";
import type { ReactNode } from "react";
import type { DevtoolsClient } from "../devtools/api";
import type { CapturedScreen } from "./expo-adapters";
import { useBugForm, useIdentityEmail, useScreenCapture } from "./hooks";
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
  labelHint?: string;
  placeholder?: string;
  hint?: string;
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
          labelHint={props.labelHint}
          value={typeof field.value === "string" ? field.value : ""}
          onChangeText={field.onChange}
          onBlur={field.onBlur}
          placeholder={props.placeholder}
          hint={props.hint}
          error={fieldState.error?.message}
          multiline={props.multiline}
          autoCapitalize={props.autoCapitalize}
          keyboardType={props.keyboardType}
        />
      )}
    />
  );
}

/** Capture-the-screen control shared by the bug + feature forms. Shows only
 *  when a session is present (the public intake takes no attachments) AND the
 *  host installed react-native-view-shot. Tapping it hides the overlay, shoots
 *  the current app screen, and stores a thumbnail the submit will upload. */
export function ScreenshotAttach(props: {
  screenshot: CapturedScreen | null;
  onChange: (shot: CapturedScreen | null) => void;
  /** False for the public path — attachments need an authed session. */
  enabled: boolean;
}): ReactNode {
  const t = useTheme();
  const capture = useScreenCapture();
  const [busy, setBusy] = useState(false);
  if (!props.enabled || !capture.available) return null;

  const take = async () => {
    setBusy(true);
    try {
      const shot = await capture.capture();
      if (shot) props.onChange(shot);
    } finally {
      setBusy(false);
    }
  };

  if (props.screenshot) {
    return (
      <View style={[styles.shotWrap, { borderColor: t.border, borderRadius: t.radius }]}>
        <Image source={{ uri: props.screenshot.uri }} style={styles.shotThumb} resizeMode="cover" />
        <View style={styles.shotCopy}>
          <Text style={[styles.shotTitle, { color: t.fg }]}>Screenshot attached</Text>
          <Muted numberOfLines={1}>{props.screenshot.filename}</Muted>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove screenshot"
          onPress={() => props.onChange(null)}
          hitSlop={8}
        >
          <Text style={[styles.shotRemove, { color: t.fgMuted }]}>✕</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Attach a screenshot of this screen"
      onPress={() => void take()}
      disabled={busy}
      style={({ pressed }) => [
        styles.shotButton,
        { borderColor: t.border, borderRadius: t.radius, opacity: pressed || busy ? 0.7 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={t.fgMuted} />
      ) : (
        <Text style={[styles.shotButtonText, { color: t.fg }]}>⧉ Attach a screenshot</Text>
      )}
    </Pressable>
  );
}

export function BugForm(props: {
  config: DevtoolsConfig;
  client: DevtoolsClient | null;
  context?: Record<string, unknown>;
  onDone: () => void;
}): ReactNode {
  const t = useTheme();
  const identityEmail = useIdentityEmail();
  const { form, ...state } = useBugForm({
    config: props.config,
    client: props.client,
    context: { ...defaultContext(), ...props.context },
  });

  if (state.result) {
    return (
      <View style={styles.done}>
        <View style={[styles.doneMark, { backgroundColor: t.accentSoft }]}>
          <Text style={[styles.doneGlyph, { color: t.ok }]}>✓</Text>
        </View>
        <Title>Thanks — bug filed</Title>
        {state.result.number !== undefined ? (
          <View style={[styles.doneTicket, { borderColor: t.border, backgroundColor: t.surface }]}>
            <Text style={[styles.doneTicketNo, { color: t.accent }]}>#{state.result.number}</Text>
          </View>
        ) : null}
        <Muted style={styles.doneDetail}>
          {state.result.number !== undefined
            ? state.result.deduped
              ? "This matches a report already in the queue — we bumped it instead of duplicating."
              : "It's in the project's triage queue and will be reviewed shortly."
            : "Your report was filed."}
        </Muted>
        <Button title="Done" onPress={props.onDone} style={styles.doneButton} />
      </View>
    );
  }

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={styles.form}
      showsVerticalScrollIndicator={false}
    >
      <Title style={styles.heading}>Report a bug</Title>
      <Muted style={styles.blurb}>
        Goes straight to the project's triage queue — the more you can tell us, the faster it's
        fixed.
      </Muted>

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
        labelHint="optional"
        placeholder="The error or wrong behaviour you saw"
        multiline
      />
      <ControlledField
        control={form.control}
        name="stepsToReproduce"
        label="Steps to reproduce"
        labelHint="optional"
        placeholder={"1. Open …\n2. Tap …"}
        multiline
      />
      {identityEmail ? (
        // The app already identified this user — don't ask for what we know.
        <View style={[styles.identityRow, { backgroundColor: t.surface, borderColor: t.border, borderRadius: t.radius }]}>
          <View style={[styles.identityDot, { backgroundColor: t.ok }]} />
          <Muted style={styles.identityText} numberOfLines={1}>
            Follow-ups go to {identityEmail}
          </Muted>
        </View>
      ) : (
        <ControlledField
          control={form.control}
          name="reporterEmail"
          label="Your email"
          labelHint="optional"
          placeholder="you@example.com"
          hint="Only used to follow up on this report."
          autoCapitalize="none"
          keyboardType="email-address"
        />
      )}
      <ScreenshotAttach
        screenshot={state.screenshot}
        onChange={state.setScreenshot}
        enabled={props.client !== null}
      />
      {state.submitError ? (
        <View style={[styles.submitError, { backgroundColor: t.surface, borderColor: t.danger, borderRadius: t.radius }]}>
          <Text style={[styles.submitErrorText, { color: t.danger }]}>{state.submitError}</Text>
        </View>
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
  blurb: { marginBottom: 18 },
  cancel: { marginTop: 6 },
  done: { alignItems: "center", gap: 10, padding: 24, paddingTop: 40 },
  doneButton: { alignSelf: "stretch", marginTop: 18 },
  doneDetail: { paddingHorizontal: 12, textAlign: "center" },
  doneGlyph: { fontSize: 26, fontWeight: "700" },
  doneMark: {
    alignItems: "center",
    borderRadius: 999,
    height: 56,
    justifyContent: "center",
    marginBottom: 4,
    width: 56,
  },
  doneTicket: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 3 },
  doneTicketNo: { fontSize: 13, fontVariant: ["tabular-nums"], fontWeight: "700" },
  form: { paddingBottom: 32, paddingTop: 6 },
  heading: { marginBottom: 4 },
  identityDot: { borderRadius: 999, height: 8, width: 8 },
  identityRow: {
    alignItems: "center",
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginBottom: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  identityText: { flex: 1 },
  shotButton: {
    alignItems: "center",
    borderStyle: "dashed",
    borderWidth: 1,
    justifyContent: "center",
    marginBottom: 14,
    minHeight: 46,
    paddingVertical: 12,
  },
  shotButtonText: { fontSize: 14, fontWeight: "600" },
  shotCopy: { flex: 1, gap: 2 },
  shotRemove: { fontSize: 15, padding: 4 },
  shotThumb: { borderRadius: 6, height: 44, width: 44 },
  shotTitle: { fontSize: 13, fontWeight: "600" },
  shotWrap: {
    alignItems: "center",
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginBottom: 14,
    padding: 8,
  },
  submitError: {
    borderWidth: 1,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  submitErrorText: { fontSize: 13 },
});
