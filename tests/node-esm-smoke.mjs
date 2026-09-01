import { readFileSync } from "node:fs"
import { File, FileReclaimer, FileSystem } from "@popcomputer/files"
import {
  FileCatalog,
  FileObjects,
  FileReclamationCatalog,
} from "@popcomputer/files/adapter"
import { makeFilesClient } from "@popcomputer/files/client"
import {
  DEFAULT_CLOUDFLARE_FILE_CAPABILITY_POLICY,
  makeCloudflareFileDataPlaneHandler,
  makeCloudflareFileObjects,
} from "@popcomputer/files/cloudflare"
import {
  makeD1FileCatalog,
  makeD1FileReclamationCatalog,
} from "@popcomputer/files/d1"
import {
  d1Files,
  d1FileFolderRequests,
  d1FileUploadRequests,
} from "@popcomputer/files/d1/schema"
import { makeFilesHttpHandler } from "@popcomputer/files/http"
import { layer as inMemoryFiles } from "@popcomputer/files/in-memory"
import {
  FileReclaimer as FileReclaimerService,
  FileReclaimerPolicySchema,
  batchSize as reclaimerBatchSize,
  layer as fileReclaimerLayer,
} from "@popcomputer/files/reclaimer"
import { FileTestControl } from "@popcomputer/files/testing"
import { Effect, Layer, Redacted } from "effect"

const runtime = FileSystem.layer({
  maximumUploadBytes: FileSystem.byteCount(1024),
}).pipe(
  Layer.provideMerge(
    Layer.merge(
      inMemoryFiles(),
      FileSystem.fixedQuotaPolicyLayer(FileSystem.byteCount(4096)),
    ),
  ),
)

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem
    const fileSystemId = File.FileSystemIdSchema.make("node-smoke")
    const actor = File.FileActorSchema.make({
      kind: File.FileActorKindSchema.make("test"),
      id: File.FileActorIdSchema.make("test-actor"),
    })
    return yield* files.createFolder({
      fileSystemId,
      actor,
      parentId: null,
      name: File.FileNameSchema.make("documents"),
      idempotencyKey: File.IdempotencyKeySchema.make("folder-documents"),
    })
  }).pipe(Effect.provide(runtime)),
)

if (result._tag !== "Folder" || result.path !== "documents") {
  throw new Error("Root and in-memory entry points failed")
}

if (
  !FileCatalog ||
  !FileObjects ||
  !FileReclamationCatalog ||
  !FileReclaimer.FileReclaimer ||
  !FileReclaimer.FileReclaimerPolicySchema ||
  !FileReclaimer.batchSize ||
  !FileReclaimer.layer ||
  !FileReclaimerService ||
  !FileReclaimerPolicySchema ||
  !reclaimerBatchSize ||
  !fileReclaimerLayer ||
  !FileTestControl ||
  !makeFilesHttpHandler ||
  !makeFilesClient ||
  !makeD1FileCatalog ||
  !makeD1FileReclamationCatalog ||
  !d1Files ||
  !d1FileFolderRequests ||
  !d1FileUploadRequests ||
  !DEFAULT_CLOUDFLARE_FILE_CAPABILITY_POLICY ||
  !makeCloudflareFileObjects ||
  !makeCloudflareFileDataPlaneHandler
) {
  throw new Error("One or more public entry points failed")
}

const client = makeFilesClient({
  baseUrl: new URL("https://example.com/api/files"),
  apiToken: Redacted.make("smoke-secret"),
  fetch: async () => new Response(null, { status: 503 }),
})

if (!client.listChildren || !client.putFile) {
  throw new Error("Client entry point failed")
}

const migrationUrl = import.meta.resolve(
  "@popcomputer/files/migrations/d1/0001_files.sql",
)
const packageRoot = new URL("../../", migrationUrl)
const migration = readFileSync(new URL(migrationUrl), "utf8")
if (!migration.includes("CREATE TABLE IF NOT EXISTS popcomputer_files")) {
  throw new Error("Published D1 migration failed")
}
for (const requiredFile of [
  "README.md",
  "SECURITY.md",
  "LICENSE",
  "docs/architecture.md",
]) {
  if (readFileSync(new URL(requiredFile, packageRoot), "utf8").length === 0) {
    throw new Error(`Published ${requiredFile} failed`)
  }
}
