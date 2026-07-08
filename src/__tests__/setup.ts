// Vitest global setup.
//
// The SDK's egress defaults (network + usage telemetry) are OFF outside
// production so an app embedding the SDK never phones home from a dev / CI run
// (see ../env.ts). Vitest itself runs under NODE_ENV="test", which would make
// every engine construct offline by default and break the suites that exercise
// the live /sdk/evaluate, /collect and telemetry paths.
//
// Declare the hermetic suite production-equivalent for the egress defaults so
// those tests keep their historical network-on behaviour. The dedicated tests
// in env-defaults.test.ts override SHIPEASY_ENV/NODE_ENV locally to assert the
// real dev/prod branching.
process.env.SHIPEASY_ENV = "production";
