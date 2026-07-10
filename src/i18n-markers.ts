// i18n label-marker constants + encoder (formerly @shipeasy/i18n-core, then
// inlined in src/client). Split into a standalone module so the browser
// devtools overlay (src/browser-devtools) can import the markers without
// pulling the whole client Engine into its bundle. Pure — no other client
// dependencies. Re-exported unchanged from `@shipeasy/sdk/client`.

export const LABEL_MARKER_START = "￹";
export const LABEL_MARKER_SEP = "￺";
export const LABEL_MARKER_END = "￻";
// 3-section format: ￹key￺varsJson￺value￻ — varsJson is "" when no vars,
// otherwise JSON.stringify(vars). Devtools picks up vars without diffing
// template against value.
export const LABEL_MARKER_RE = /￹([^￺￻]+)￺([^￺￻]*)￺([^￻]*)￻/g;

export function encodeLabelMarker(
  key: string,
  value: string,
  // Structural mirror of the client's `I18nVariables` alias (kept inline so
  // this module has zero imports from src/client).
  variables?: Record<string, string | number | null | undefined>,
): string {
  const varsJson = variables && Object.keys(variables).length > 0 ? JSON.stringify(variables) : "";
  return `${LABEL_MARKER_START}${key}${LABEL_MARKER_SEP}${varsJson}${LABEL_MARKER_SEP}${value}${LABEL_MARKER_END}`;
}
