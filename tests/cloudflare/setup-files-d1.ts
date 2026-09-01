import { applyD1Migrations } from "cloudflare:test"
import { env } from "cloudflare:workers"

await applyD1Migrations(
  env.FILES_DB,
  env.TEST_MIGRATIONS.map((migration) => ({
    name: migration.name,
    queries: [...migration.queries],
  })),
)
