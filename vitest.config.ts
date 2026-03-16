import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    exclude: ["test/e2e.test.ts", "node_modules"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.test.toml" },
        miniflare: {
          d1Databases: {
            DB: "test-db",
          },
          r2Buckets: {
            BUCKET: "test-bucket",
          },
        },
      },
    },
  },
});
