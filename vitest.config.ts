import { defineConfig } from 'vitest/config';
// Bound concurrent WASM physics fixtures on the local development machine.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], exclude: ['tests/e2e/**'], testTimeout: 15000, maxWorkers: 2 } });
