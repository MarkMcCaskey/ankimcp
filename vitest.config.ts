import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    exclude: ["test/e2e.test.ts", "node_modules"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          d1Databases: {
            DB: "test-db",
          },
          r2Buckets: {
            BUCKET: "test-bucket",
          },
          bindings: {
            AUTH_TOKEN: { get: () => Promise.resolve("test-secret-token") },
            SYNC_USERNAME: { get: () => Promise.resolve("testuser") },
            SYNC_PASSWORD: { get: () => Promise.resolve("testpass") },
          },
        },
      },
    },
  },
});
