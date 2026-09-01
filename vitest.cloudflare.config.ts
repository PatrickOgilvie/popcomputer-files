import path from "node:path"
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "migrations", "d1"),
  )

  return {
    root: import.meta.dirname,
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-08-22",
          d1Databases: ["FILES_DB"],
          r2Buckets: ["FILES_BUCKET"],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["tests/cloudflare/**/*.worker.ts"],
      setupFiles: ["./tests/cloudflare/setup-files-d1.ts"],
    },
  }
})
