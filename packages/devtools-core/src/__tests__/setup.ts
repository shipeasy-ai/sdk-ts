// The SDK's egress defaults (network + usage telemetry) are OFF outside
// production so nothing phones home from a dev / CI run. Vitest runs under
// NODE_ENV="test"; declare the hermetic suite production-equivalent so the
// devtools suites keep their historical network-on behaviour. Mirrors the
// SDK's own src/__tests__/setup.ts.
process.env.SHIPEASY_ENV = "production";
