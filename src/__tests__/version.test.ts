import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { version as clientVersion } from "../client/index";
import { version as serverVersion } from "../server/index";

// The exported `version` rides every see() event as `sdk_version`. It was frozen
// at "4.0.0" through 9.x, so the dashboard could not tell which SDK reported.
describe("sdk version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };

  it("client and server report the published package version", () => {
    expect(clientVersion).toBe(pkg.version);
    expect(serverVersion).toBe(pkg.version);
  });
});
