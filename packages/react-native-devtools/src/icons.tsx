// Section icons for the drill-in menu — the SAME Lucide glyphs the in-browser
// overlay uses (see browser-devtools/icons.ts): users / shield / flask /
// sliders / book / bug / activity. Rendered through react-native-svg, an
// OPTIONAL peer (present in typical Expo apps; `lucide-react-native` pulls it
// in too). When it's absent the guarded require below misses and we fall back
// to a text glyph, so the menu still reads on a bare RN runtime.

import * as React from "react";
import { Text } from "react-native";
import type { ReactNode } from "react";

// Guarded require — Metro's allowOptionalDependencies (on by default in Expo)
// permits the miss; a bundler alias (the gallery) resolves it to a web SVG stub.
/* eslint-disable @typescript-eslint/no-require-imports */
let RNSvg: {
  Svg: React.ComponentType<Record<string, unknown>>;
  Path: React.ComponentType<Record<string, unknown>>;
  Circle: React.ComponentType<Record<string, unknown>>;
  Line: React.ComponentType<Record<string, unknown>>;
  Rect: React.ComponentType<Record<string, unknown>>;
  G: React.ComponentType<Record<string, unknown>>;
} | null = null;
try {
  RNSvg = require("react-native-svg") as typeof RNSvg;
} catch {
  /* optional — text-glyph fallback */
}
/* eslint-enable @typescript-eslint/no-require-imports */

export type DevtoolsIconName =
  | "user"
  | "gates"
  | "configs"
  | "experiments"
  | "i18n"
  | "feedback"
  | "events"
  | "bug";

/** Text-glyph fallback for runtimes without react-native-svg. */
const FALLBACK: Record<DevtoolsIconName, string> = {
  user: "👤",
  gates: "🚩",
  configs: "🎚",
  experiments: "🧪",
  i18n: "🌐",
  feedback: "🐞",
  events: "📈",
  bug: "🐞",
};

/** The Lucide primitives for each icon, emitted as react-native-svg children.
 *  Path data copied verbatim from browser-devtools/icons.ts. */
function shapes(name: DevtoolsIconName): ReactNode {
  if (!RNSvg) return null;
  const { Path, Circle, Line, Rect } = RNSvg;
  switch (name) {
    case "user": // lucide "users"
      return (
        <>
          <Path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <Circle cx={9} cy={7} r={4} />
          <Path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <Path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </>
      );
    case "gates": // lucide "shield"
      return (
        <Path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      );
    case "experiments": // lucide "flask"
      return (
        <>
          <Path d="M10 2v7.31" />
          <Path d="M14 9.3V1.99" />
          <Path d="M8.5 2h7" />
          <Path d="M14 9.3a6.5 6.5 0 0 1 3.923 10.5H6.077A6.5 6.5 0 0 1 10 9.3" />
        </>
      );
    case "configs": // lucide "sliders"
      return (
        <>
          <Line x1={4} x2={4} y1={21} y2={14} />
          <Line x1={4} x2={4} y1={10} y2={3} />
          <Line x1={12} x2={12} y1={21} y2={12} />
          <Line x1={12} x2={12} y1={8} y2={3} />
          <Line x1={20} x2={20} y1={21} y2={16} />
          <Line x1={20} x2={20} y1={12} y2={3} />
          <Line x1={2} x2={6} y1={14} y2={14} />
          <Line x1={10} x2={14} y1={8} y2={8} />
          <Line x1={18} x2={22} y1={16} y2={16} />
        </>
      );
    case "i18n": // lucide "book"
      return <Path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />;
    case "feedback":
    case "bug": // lucide "bug"
      return (
        <>
          <Path d="M8 6V4a4 4 0 0 1 8 0v2" />
          <Rect x={6} y={6} width={12} height={14} rx={6} />
          <Path d="M3 12h3" />
          <Path d="M18 12h3" />
          <Path d="M3 18l3-2" />
          <Path d="M21 18l-3-2" />
          <Path d="M3 6l3 2" />
          <Path d="M21 6l-3 2" />
        </>
      );
    case "events": // lucide "activity"
      return <Path d="M22 12h-4l-3 9L9 3l-3 9H2" />;
  }
}

/** A section icon. Renders the Lucide SVG when react-native-svg is available,
 *  otherwise a matching emoji glyph. Stroke/fill come from `color`. */
export function Icon(props: { name: DevtoolsIconName; size?: number; color: string }): ReactNode {
  const size = props.size ?? 18;
  if (!RNSvg) {
    return <Text style={{ color: props.color, fontSize: Math.round(size * 0.9) }}>{FALLBACK[props.name]}</Text>;
  }
  const { Svg, G } = RNSvg;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <G
        stroke={props.color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        {shapes(props.name)}
      </G>
    </Svg>
  );
}
