import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, DIVOICE_SECRET: "test-secret-0123456789abcdef0123456789" },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
