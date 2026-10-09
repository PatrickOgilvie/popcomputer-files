import { env } from "cloudflare:workers"
import { Effect, Layer, Redacted } from "effect"
import { describe, expect, test } from "vitest"
import { FileObjectLocatorSchema } from "../../src/adapter.js"
import {
  ByteCountSchema,
  FileActorIdSchema,
  FileActorKindSchema,
  FileActorSchema,
  FileContentTypeSchema,
  FileIdSchema,
  FileNameSchema,
  FileSystemIdSchema,
  IdempotencyKeySchema,
  MaintenanceBatchSizeSchema,
  PageSizeSchema,
  DurationMillisSchema,
  Sha256Schema,
  TimestampMillisSchema,
  rootListTarget,
  type FileSystemId,
} from "../../src/file.js"
import {
  DEFAULT_CLOUDFLARE_FILE_CAPABILITY_POLICY,
  cloudflareFileObjectsLayer,
  makeCloudflareFileDataPlaneHandler,
  makeCloudflareFileObjects,
} from "../../src/integrations/cloudflare.js"
import {
  d1FileCatalogLayer,
  makeD1FileCatalog,
} from "../../src/integrations/d1.js"
import {
  FileReclaimer,
  FileReclaimerPolicySchema,
  layer as fileReclaimerLayer,
} from "../../src/reclaimer.js"

const signingSecret = Redacted.make(
  "workerd-test-signing-secret-with-at-least-32-bytes",
)
const capabilityPolicy = DEFAULT_CLOUDFLARE_FILE_CAPABILITY_POLICY

const makeR2UploadFixture = async (maximumBytes = 5) => {
  const suffix = crypto.randomUUID()
  const objects = makeCloudflareFileObjects({
    bucket: env.FILES_BUCKET,
    capabilityOrigin: new URL("https://files.example.com"),
    signingSecret,
    capabilityPolicy,
  })
  const fileSystemId = FileSystemIdSchema.make(`workerd-r2:${suffix}`)
  const locator = objects.locationFor(
    fileSystemId,
    FileIdSchema.make(crypto.randomUUID()),
  )
  const upload = await Effect.runPromise(
    objects.issueUpload({
      locator,
      maximumBytes: ByteCountSchema.make(maximumBytes),
      expiresAt: TimestampMillisSchema.make(
        Date.now() + objects.uploadCapabilityTtlMillis,
      ),
      sha256: null,
      contentType: null,
    }),
  )
  const handler = makeCloudflareFileDataPlaneHandler({
    bucket: env.FILES_BUCKET,
    signingSecret,
    capabilityPolicy,
  })
  return { handler, locator, objects, upload }
}

const uploadRequest = (
  url: string,
  body: BodyInit,
  contentLength: number,
): Request =>
  new Request(url, {
    method: "PUT",
    body,
    headers: { "Content-Length": String(contentLength) },
  })

describe("Cloudflare production adapters in workerd", () => {
  test("executes the catalog through a real D1 binding", async () => {
    const catalog = makeD1FileCatalog(env.FILES_DB)
    const suffix = crypto.randomUUID()
    const fileSystemId = FileSystemIdSchema.make(`workerd:${suffix}`)
    const actor = FileActorSchema.make({
      kind: FileActorKindSchema.make("test"),
      id: FileActorIdSchema.make("workerd-test"),
    })
    const created = await Effect.runPromise(
      catalog.createFolder({
        fileSystemId,
        actor,
        now: TimestampMillisSchema.make(Date.now()),
        id: FileIdSchema.make(crypto.randomUUID()),
        parentId: null,
        name: FileNameSchema.make("documents"),
        idempotencyKey: IdempotencyKeySchema.make(`folder:${suffix}`),
      }),
    )
    expect(created._tag).toBe("Created")

    const upload = await Effect.runPromise(
      catalog.reserveUpload({
        fileSystemId,
        actor,
        now: TimestampMillisSchema.make(Date.now()),
        id: FileIdSchema.make(crypto.randomUUID()),
        parentId: null,
        name: FileNameSchema.make("report.txt"),
        idempotencyKey: IdempotencyKeySchema.make(`upload:${suffix}`),
        locator: FileObjectLocatorSchema.make(`workerd:${suffix}`),
        maximumBytes: ByteCountSchema.make(5),
        pendingExpiresAt: TimestampMillisSchema.make(Date.now() + 60_000),
        expectedSha256: null,
      }),
    )
    if (upload._tag !== "Created") {
      throw new Error("D1 upload reservation failed")
    }
    const confirmed = await Effect.runPromise(
      catalog.confirmUpload({
        fileSystemId,
        actor,
        now: TimestampMillisSchema.make(Date.now()),
        fileId: upload.node.id,
        size: ByteCountSchema.make(5),
        contentType: FileContentTypeSchema.make("text/plain"),
        digest: null,
        quotaBytes: ByteCountSchema.make(10),
      }),
    )
    expect(confirmed._tag).toBe("Confirmed")

    const page = await Effect.runPromise(
      catalog.listChildren(fileSystemId, rootListTarget, {
        size: PageSizeSchema.make(100),
        cursor: null,
      }),
    )
    expect(page._tag).toBe("Page")
    if (page._tag === "Page") {
      expect(page.page.items.map((node) => node.name)).toEqual([
        "documents",
        "report.txt",
      ])
    }
  })

  test("atomically enforces one filesystem quota across concurrent confirmations", async () => {
    const catalog = makeD1FileCatalog(env.FILES_DB)
    const suffix = crypto.randomUUID()
    const fileSystemId = FileSystemIdSchema.make(`workerd-race:${suffix}`)
    const actor = FileActorSchema.make({
      kind: FileActorKindSchema.make("test"),
      id: FileActorIdSchema.make("workerd-test"),
    })
    const now = TimestampMillisSchema.make(Date.now())
    const pendingExpiresAt = TimestampMillisSchema.make(now + 60_000)
    const maximumBytes = ByteCountSchema.make(5)

    const first = await Effect.runPromise(
      catalog.reserveUpload({
        fileSystemId,
        actor,
        now,
        id: FileIdSchema.make(crypto.randomUUID()),
        parentId: null,
        name: FileNameSchema.make("first.txt"),
        idempotencyKey: IdempotencyKeySchema.make(`race:${suffix}:first`),
        locator: FileObjectLocatorSchema.make(`race:${suffix}:first`),
        maximumBytes,
        pendingExpiresAt,
        expectedSha256: null,
      }),
    )
    const second = await Effect.runPromise(
      catalog.reserveUpload({
        fileSystemId,
        actor,
        now,
        id: FileIdSchema.make(crypto.randomUUID()),
        parentId: null,
        name: FileNameSchema.make("second.txt"),
        idempotencyKey: IdempotencyKeySchema.make(`race:${suffix}:second`),
        locator: FileObjectLocatorSchema.make(`race:${suffix}:second`),
        maximumBytes,
        pendingExpiresAt,
        expectedSha256: null,
      }),
    )
    if (first._tag !== "Created" || second._tag !== "Created") {
      throw new Error("D1 race upload reservation failed")
    }

    const confirm = (fileId: typeof first.node.id) =>
      Effect.runPromise(
        catalog.confirmUpload({
          fileSystemId,
          actor,
          now: TimestampMillisSchema.make(Date.now()),
          fileId,
          size: maximumBytes,
          contentType: FileContentTypeSchema.make("text/plain"),
          digest: null,
          quotaBytes: maximumBytes,
        }),
      )
    const outcomes = await Promise.all([
      confirm(first.node.id),
      confirm(second.node.id),
    ])

    expect(outcomes.map((outcome) => outcome._tag).sort()).toEqual([
      "Confirmed",
      "QuotaExceeded",
    ])
  })

  test("classifies concurrent upload reservation races atomically", async () => {
    const catalog = makeD1FileCatalog(env.FILES_DB)
    const suffix = crypto.randomUUID()
    const actor = FileActorSchema.make({
      kind: FileActorKindSchema.make("test"),
      id: FileActorIdSchema.make("workerd-test"),
    })
    const reserve = (
      fileSystemId: FileSystemId,
      idempotencyKey: string,
      name: string,
      maximumBytes = 5,
    ) => {
      const now = Date.now()
      return Effect.runPromise(
        catalog.reserveUpload({
          fileSystemId,
          actor,
          now: TimestampMillisSchema.make(now),
          id: FileIdSchema.make(crypto.randomUUID()),
          parentId: null,
          name: FileNameSchema.make(name),
          idempotencyKey: IdempotencyKeySchema.make(idempotencyKey),
          locator: FileObjectLocatorSchema.make(crypto.randomUUID()),
          maximumBytes: ByteCountSchema.make(maximumBytes),
          pendingExpiresAt: TimestampMillisSchema.make(now + 60_000),
          expectedSha256: null,
        }),
      )
    }
    const resultTags = (
      results: Awaited<ReturnType<typeof reserve>>[],
    ): string[] => results.map((result) => result._tag).sort()

    const identicalFileSystemId = FileSystemIdSchema.make(
      `workerd-reserve-identical:${suffix}`,
    )
    const identical = await Promise.all([
      reserve(identicalFileSystemId, `identical:${suffix}`, "same.txt"),
      reserve(identicalFileSystemId, `identical:${suffix}`, "same.txt"),
    ])
    expect(resultTags(identical)).toEqual(["Created", "ReplayPending"])
    const created = identical.find((result) => result._tag === "Created")
    const replay = identical.find((result) => result._tag === "ReplayPending")
    if (created?._tag !== "Created" || replay?._tag !== "ReplayPending") {
      throw new Error("D1 did not classify the identical reservation race")
    }
    expect(replay.node.id).toBe(created.node.id)

    const conflictFileSystemId = FileSystemIdSchema.make(
      `workerd-reserve-conflict:${suffix}`,
    )
    const fingerprintConflict = await Promise.all([
      reserve(conflictFileSystemId, `conflict:${suffix}`, "same.txt", 5),
      reserve(conflictFileSystemId, `conflict:${suffix}`, "same.txt", 6),
    ])
    expect(resultTags(fingerprintConflict)).toEqual([
      "Created",
      "IdempotencyConflict",
    ])

    const nameFileSystemId = FileSystemIdSchema.make(
      `workerd-reserve-name:${suffix}`,
    )
    const nameConflict = await Promise.all([
      reserve(nameFileSystemId, `name:${suffix}:first`, "same.txt"),
      reserve(nameFileSystemId, `name:${suffix}:second`, "same.txt"),
    ])
    expect(resultTags(nameConflict)).toEqual(["Created", "NameConflict"])
  })

  test("classifies concurrent folder-create command races atomically", async () => {
    const catalog = makeD1FileCatalog(env.FILES_DB)
    const suffix = crypto.randomUUID()
    const actor = FileActorSchema.make({
      kind: FileActorKindSchema.make("test"),
      id: FileActorIdSchema.make("workerd-test"),
    })
    const create = (
      fileSystemId: FileSystemId,
      idempotencyKey: string,
      name: string,
    ) =>
      Effect.runPromise(
        catalog.createFolder({
          fileSystemId,
          actor,
          now: TimestampMillisSchema.make(Date.now()),
          id: FileIdSchema.make(crypto.randomUUID()),
          parentId: null,
          name: FileNameSchema.make(name),
          idempotencyKey: IdempotencyKeySchema.make(idempotencyKey),
        }),
      )
    const resultTags = (
      results: Awaited<ReturnType<typeof create>>[],
    ): string[] => results.map((result) => result._tag).sort()

    const identicalFileSystemId = FileSystemIdSchema.make(
      `workerd-folder-identical:${suffix}`,
    )
    const identical = await Promise.all([
      create(identicalFileSystemId, `folder-identical:${suffix}`, "documents"),
      create(identicalFileSystemId, `folder-identical:${suffix}`, "documents"),
    ])
    expect(resultTags(identical)).toEqual(["Created", "ReplayFolder"])
    const created = identical.find((result) => result._tag === "Created")
    const replay = identical.find((result) => result._tag === "ReplayFolder")
    if (created?._tag !== "Created" || replay?._tag !== "ReplayFolder") {
      throw new Error("D1 did not classify the identical folder-create race")
    }
    expect(replay.node.id).toBe(created.node.id)

    const conflictFileSystemId = FileSystemIdSchema.make(
      `workerd-folder-conflict:${suffix}`,
    )
    const fingerprintConflict = await Promise.all([
      create(conflictFileSystemId, `folder-conflict:${suffix}`, "first"),
      create(conflictFileSystemId, `folder-conflict:${suffix}`, "second"),
    ])
    expect(resultTags(fingerprintConflict)).toEqual([
      "Created",
      "IdempotencyConflict",
    ])

    const nameFileSystemId = FileSystemIdSchema.make(
      `workerd-folder-name:${suffix}`,
    )
    const nameConflict = await Promise.all([
      create(nameFileSystemId, `folder-name:${suffix}:first`, "same"),
      create(nameFileSystemId, `folder-name:${suffix}:second`, "same"),
    ])
    expect(resultTags(nameConflict)).toEqual(["Created", "NameConflict"])
  })

  test("commits exactly one of two concurrent uploads through real R2", async () => {
    const { handler, locator, objects, upload } =
      await makeR2UploadFixture()
    try {
      const [first, second] = await Promise.all([
        handler(uploadRequest(upload.url, "first", 5)),
        handler(uploadRequest(upload.url, "other", 5)),
      ])
      expect(first.status).toBe(204)
      expect(second.status).toBe(204)

      const stored = await env.FILES_BUCKET.get(locator)
      const winningBody = await stored?.text()
      expect(["first", "other"]).toContain(winningBody)

      const replay = await handler(
        uploadRequest(upload.url, "later", 5),
      )
      expect(replay.status).toBe(204)
      expect(await (await env.FILES_BUCKET.get(locator))?.text()).toBe(
        winningBody,
      )

      const download = await Effect.runPromise(
        objects.issueDownload({
          locator,
          fileName: FileNameSchema.make("report.txt"),
        }),
      )
      const response = await handler(new Request(download.url))
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(winningBody)
      expect(response.headers.get("Content-Disposition")).toContain(
        "report.txt",
      )
    } finally {
      await env.FILES_BUCKET.delete(locator)
    }
  })

  test("deletes an R2 object idempotently", async () => {
    const { handler, locator, objects, upload } = await makeR2UploadFixture()
    try {
      const stored = await handler(uploadRequest(upload.url, "valid", 5))
      expect(stored.status).toBe(204)
      expect(await env.FILES_BUCKET.head(locator)).not.toBeNull()

      await Effect.runPromise(objects.delete(locator))
      await Effect.runPromise(objects.delete(locator))

      expect(await env.FILES_BUCKET.head(locator)).toBeNull()
    } finally {
      await env.FILES_BUCKET.delete(locator)
    }
  })

  test("leaves no object after an oversized upload and permits retry", async () => {
    const { handler, locator, upload } = await makeR2UploadFixture()
    try {
      const oversized = await handler(
        uploadRequest(upload.url, "larger", 6),
      )
      expect(oversized.status).toBe(413)
      expect(await env.FILES_BUCKET.head(locator)).toBeNull()

      const retry = await handler(
        uploadRequest(upload.url, "valid", 5),
      )
      expect(retry.status).toBe(204)
      expect(await (await env.FILES_BUCKET.get(locator))?.text()).toBe(
        "valid",
      )
    } finally {
      await env.FILES_BUCKET.delete(locator)
    }
  })

  test("maps interrupted uploads to 503 without consuming the capability", async () => {
    const { handler, locator, upload } = await makeR2UploadFixture()
    try {
      const interrupted = await handler(
        uploadRequest(upload.url, "ab", 5),
      )
      expect(interrupted.status).toBe(503)
      expect(await env.FILES_BUCKET.head(locator)).toBeNull()

      const retry = await handler(
        uploadRequest(upload.url, "valid", 5),
      )
      expect(retry.status).toBe(204)
      expect(await (await env.FILES_BUCKET.get(locator))?.text()).toBe(
        "valid",
      )
    } finally {
      await env.FILES_BUCKET.delete(locator)
    }
  })

  test("drains a D1 tombstone through the real R2 deletion seam", async () => {
    const suffix = crypto.randomUUID()
    const fileSystemId = FileSystemIdSchema.make(`workerd-reclaim:${suffix}`)
    const fileId = FileIdSchema.make(`file:${suffix}`)
    const actor = FileActorSchema.make({
      kind: FileActorKindSchema.make("system"),
      id: FileActorIdSchema.make("workerd-reclaimer"),
    })
    const objects = makeCloudflareFileObjects({
      bucket: env.FILES_BUCKET,
      capabilityOrigin: new URL("https://files.example.com"),
      signingSecret,
      capabilityPolicy,
    })
    const locator = objects.locationFor(fileSystemId, fileId)
    const now = Date.now()
    const reservation = {
      fileSystemId,
      actor,
      now: TimestampMillisSchema.make(now - 10),
      id: fileId,
      parentId: null,
      name: FileNameSchema.make("abandoned.bin"),
      idempotencyKey: IdempotencyKeySchema.make(`reclaim:${suffix}`),
      locator,
      maximumBytes: ByteCountSchema.make(5),
      pendingExpiresAt: TimestampMillisSchema.make(now - 1),
      expectedSha256: null,
    }
    const catalog = makeD1FileCatalog(env.FILES_DB)

    try {
      const created = await Effect.runPromise(catalog.reserveUpload(reservation))
      expect(created._tag).toBe("Created")
      await env.FILES_BUCKET.put(locator, "bytes")

      const infrastructure = Layer.merge(
        d1FileCatalogLayer(env.FILES_DB),
        cloudflareFileObjectsLayer({
          bucket: env.FILES_BUCKET,
          capabilityOrigin: new URL("https://files.example.com"),
          signingSecret,
          capabilityPolicy,
        }),
      )
      const runtime = fileReclaimerLayer(
        FileReclaimerPolicySchema.make({
          actor,
          batchSize: MaintenanceBatchSizeSchema.make(10),
          concurrency: 2,
          retryDelayMillis: DurationMillisSchema.make(1_000),
          metadataRetentionMillis: DurationMillisSchema.make(0),
          changeRetentionMillis: DurationMillisSchema.make(0),
        }),
      ).pipe(Layer.provide(infrastructure))
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const reclaimer = yield* FileReclaimer
          const report = yield* reclaimer.runBatch()
          const purged = yield* reclaimer.purgeMetadataBatch()
          return { report, purged }
        }).pipe(Effect.provide(runtime)),
      )

      expect(result.report.expiredPending).toBe(1)
      expect(result.report.outcomes.map((outcome) => outcome._tag)).toEqual([
        "Reclaimed",
      ])
      expect(result.purged).toBe(1)
      expect(await env.FILES_BUCKET.head(locator)).toBeNull()
      expect((await Effect.runPromise(catalog.reserveUpload(reservation)))._tag).toBe(
        "ReplayUnavailable",
      )
    } finally {
      await env.FILES_BUCKET.delete(locator)
      await env.FILES_DB.prepare(
        "DELETE FROM popcomputer_files WHERE file_system_id = ?",
      )
        .bind(fileSystemId)
        .run()
      await env.FILES_DB.prepare(
        "DELETE FROM popcomputer_file_upload_requests WHERE file_system_id = ?",
      )
        .bind(fileSystemId)
        .run()
    }
  })
})

describe("Cloudflare adapters: digests, prefixes, host bytes, moves", () => {
  const actor = FileActorSchema.make({
    kind: FileActorKindSchema.make("test"),
    id: FileActorIdSchema.make("workerd-test"),
  })
  const sha256Hex = async (value: string) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")

  const prefixedObjects = (suffix: string) =>
    makeCloudflareFileObjects({
      bucket: env.FILES_BUCKET,
      capabilityOrigin: new URL("https://files.example.com"),
      signingSecret,
      capabilityPolicy,
      keyPrefix: `tenants/${suffix}/files/`,
      capabilityPath: "/files-data/o/",
    })

  test("places objects under the host prefix and serves the host path", async () => {
    const suffix = crypto.randomUUID()
    const objects = prefixedObjects(suffix)
    const locator = objects.locationFor(
      FileSystemIdSchema.make(`prefix:${suffix}`),
      FileIdSchema.make(crypto.randomUUID()),
    )
    expect(locator.startsWith(`tenants/${suffix}/files/`)).toBe(true)
    const upload = await Effect.runPromise(
      objects.issueUpload({
        locator,
        maximumBytes: ByteCountSchema.make(5),
        expiresAt: TimestampMillisSchema.make(
          Date.now() + objects.uploadCapabilityTtlMillis,
        ),
        sha256: null,
        contentType: FileContentTypeSchema.make("text/csv"),
      }),
    )
    const url = new URL(upload.url)
    expect(url.pathname.startsWith("/files-data/o/")).toBe(true)

    const handler = makeCloudflareFileDataPlaneHandler({
      bucket: env.FILES_BUCKET,
      signingSecret,
      capabilityPolicy,
      capabilityPath: "/files-data/o/",
    })
    const wrongPath = await handler(
      new Request(`https://files.example.com/o/${url.pathname.slice(14)}`, {
        method: "PUT",
        body: "a,b",
        headers: { "Content-Length": "3" },
      }),
    )
    expect(wrongPath.status).toBe(404)
    const stored = await handler(
      new Request(upload.url, {
        method: "PUT",
        body: "a,b",
        headers: { "Content-Length": "3", "Content-Type": "text/html" },
      }),
    )
    expect(stored.status).toBe(204)
    const head = await env.FILES_BUCKET.head(locator)
    expect(head?.httpMetadata?.contentType).toBe("text/csv")
    await env.FILES_BUCKET.delete(locator)
  })

  test("lets R2 enforce a declared SHA-256 and reports it on stat", async () => {
    const suffix = crypto.randomUUID()
    const objects = prefixedObjects(suffix)
    const handler = makeCloudflareFileDataPlaneHandler({
      bucket: env.FILES_BUCKET,
      signingSecret,
      capabilityPolicy,
      capabilityPath: "/files-data/o/",
    })
    const digest = Sha256Schema.make(await sha256Hex("hello"))
    const issue = (locator: ReturnType<typeof objects.locationFor>) =>
      Effect.runPromise(
        objects.issueUpload({
          locator,
          maximumBytes: ByteCountSchema.make(5),
          expiresAt: TimestampMillisSchema.make(
            Date.now() + objects.uploadCapabilityTtlMillis,
          ),
          sha256: digest,
          contentType: null,
        }),
      )
    const fileSystemId = FileSystemIdSchema.make(`digest:${suffix}`)

    const rejectedLocator = objects.locationFor(
      fileSystemId,
      FileIdSchema.make(crypto.randomUUID()),
    )
    const rejected = await handler(
      uploadRequest((await issue(rejectedLocator)).url, "olleh", 5),
    )
    expect(rejected.status).toBe(400)
    expect(await env.FILES_BUCKET.head(rejectedLocator)).toBeNull()

    const acceptedLocator = objects.locationFor(
      fileSystemId,
      FileIdSchema.make(crypto.randomUUID()),
    )
    const accepted = await handler(
      uploadRequest((await issue(acceptedLocator)).url, "hello", 5),
    )
    expect(accepted.status).toBe(204)
    const metadata = await Effect.runPromise(objects.stat(acceptedLocator))
    expect(metadata?.digest).toEqual({ _tag: "Sha256", value: digest })
    await env.FILES_BUCKET.delete(acceptedLocator)
  })

  test("stores and streams bytes the host already holds", async () => {
    const suffix = crypto.randomUUID()
    const objects = prefixedObjects(suffix)
    const locator = objects.locationFor(
      FileSystemIdSchema.make(`host:${suffix}`),
      FileIdSchema.make(crypto.randomUUID()),
    )
    const body = new TextEncoder().encode("host bytes")
    const sha256 = Sha256Schema.make(await sha256Hex("host bytes"))
    await Effect.runPromise(
      objects.put({
        locator,
        body,
        contentType: FileContentTypeSchema.make("text/plain"),
        sha256,
      }),
    )
    await Effect.runPromise(
      objects.put({
        locator,
        body: new TextEncoder().encode("other"),
        contentType: null,
        sha256: Sha256Schema.make(await sha256Hex("other")),
      }),
    )
    const stream = await Effect.runPromise(objects.get(locator))
    expect(stream === null ? null : await new Response(stream).text()).toBe(
      "host bytes",
    )
    const metadata = await Effect.runPromise(objects.stat(locator))
    expect(metadata?.digest).toEqual({ _tag: "Sha256", value: sha256 })
    expect(metadata?.contentType).toBe("text/plain")
    await env.FILES_BUCKET.delete(locator)
  })

  test("moves subtrees and writes the change log on real D1", async () => {
    const catalog = makeD1FileCatalog(env.FILES_DB)
    const suffix = crypto.randomUUID()
    const fileSystemId = FileSystemIdSchema.make(`moves:${suffix}`)
    const now = Date.now()
    const create = async (id: string, parentId: string | null, at: number) => {
      const result = await Effect.runPromise(
        catalog.createFolder({
          fileSystemId,
          actor,
          now: TimestampMillisSchema.make(at),
          id: FileIdSchema.make(`${suffix}-${id}`),
          parentId:
            parentId === null ? null : FileIdSchema.make(`${suffix}-${parentId}`),
          name: FileNameSchema.make(id),
          idempotencyKey: IdempotencyKeySchema.make(`${suffix}:${id}`),
        }),
      )
      expect(result._tag).toBe("Created")
    }
    try {
      await create("a", null, now)
      await create("b", "a", now + 1)
      await create("c", null, now + 2)
      const moved = await Effect.runPromise(
        catalog.move({
          fileSystemId,
          actor,
          now: TimestampMillisSchema.make(now + 10),
          fileId: FileIdSchema.make(`${suffix}-a`),
          parentId: FileIdSchema.make(`${suffix}-c`),
          name: FileNameSchema.make("a2"),
          expectedUpdatedAt: null,
        }),
      )
      expect(moved._tag).toBe("Moved")
      const child = await Effect.runPromise(
        catalog.get(fileSystemId, FileIdSchema.make(`${suffix}-b`)),
      )
      expect(child?.path).toBe("c/a2/b")

      const deleted = await Effect.runPromise(
        catalog.softDelete({
          fileSystemId,
          actor,
          now: TimestampMillisSchema.make(now + 20),
          fileId: FileIdSchema.make(`${suffix}-c`),
          reclaimAfter: TimestampMillisSchema.make(now + 30),
          expectedUpdatedAt: null,
        }),
      )
      expect(deleted._tag).toBe("Deleted")
      const changes = await Effect.runPromise(
        catalog.listChanges(fileSystemId, null, PageSizeSchema.make(100)),
      )
      const described = changes.changes.map(
        (change) => `${change.kind} ${change.path}`,
      )
      // One statement's rows are logged in the engine's row order.
      expect(described.slice(0, 3)).toEqual([
        "folder_created a",
        "folder_created a/b",
        "folder_created c",
      ])
      expect(described.slice(3, 5).sort()).toEqual([
        "node_moved c/a2",
        "node_moved c/a2/b",
      ])
      expect(described.slice(5).sort()).toEqual([
        "node_deleted c",
        "node_deleted c/a2",
        "node_deleted c/a2/b",
      ])
    } finally {
      const nodes = await env.FILES_DB.prepare(
        "SELECT id FROM popcomputer_files WHERE file_system_id = ? ORDER BY length(path) DESC",
      )
        .bind(fileSystemId)
        .all<{ readonly id: string }>()
      for (const node of nodes.results) {
        await env.FILES_DB.prepare(
          "DELETE FROM popcomputer_files WHERE file_system_id = ? AND id = ?",
        )
          .bind(fileSystemId, node.id)
          .run()
      }
      for (const table of [
        "popcomputer_file_changes",
        "popcomputer_file_folder_requests",
      ]) {
        await env.FILES_DB.prepare(
          `DELETE FROM ${table} WHERE file_system_id = ?`,
        )
          .bind(fileSystemId)
          .run()
      }
    }
  })
})
