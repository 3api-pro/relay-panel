import { defineConfig } from 'vitest/config';

// Each integration file boots PostgreSQL WASM. Bound concurrent engines so
// large-core developer machines do not exhaust memory during setup.
export default defineConfig({ test: { maxWorkers: 4 } });
