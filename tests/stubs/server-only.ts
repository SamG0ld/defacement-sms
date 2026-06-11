// Test stub for the `server-only` package. In a Vitest (node) environment the real
// package throws on import (it's meant to fail a client bundle). The unit +
// integration suites import server modules (e.g. lib/figma-api.ts via the generate
// Server Actions), so we alias `server-only` to this no-op in vitest.config.ts.
export {};
