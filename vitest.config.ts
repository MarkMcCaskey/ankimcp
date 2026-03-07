import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
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
            AUTH_TOKEN: "test-secret-token",
          },
        },
      },
    },
  },
});
