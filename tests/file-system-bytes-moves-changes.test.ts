import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import {
  FileSystem,
  fixedQuotaPolicyLayer,
  layer as fileSystemLayer,
} from "../src/file-system.js"
import {
  ByteCountSchema,
  DurationMillisSchema,
  FileActorIdSchema,
  FileActorKindSchema,
  FileActorSchema,
  FileChangeSequenceSchema,
  FileContentTypeSchema,
  FileNameSchema,
  FileSystemIdSchema,
  IdempotencyKeySchema,
  MaintenanceBatchSizeSchema,
  PageSizeSchema,
  Sha256Schema,
  sha256Of,
  type FileChange,
} from "../src/file.js"
import { layer as inMemoryLayer } from "../src/in-memory.js"
import {
  FileReclaimer,
  FileReclaimerPolicySchema,
  layer as reclaimerLayer,
} from "../src/reclaimer.js"
import { FileTestControl } from "../src/testing.js"

const actor = FileActorSchema.make({
  kind: FileActorKindSchema.make("user"),
  id: FileActorIdSchema.make("user-1"),
})
const fileSystemId = FileSystemIdSchema.make("filesystem-a")
const context = { fileSystemId, actor }
const name = (value: string) => FileNameSchema.make(value)
const key = (value: string) => IdempotencyKeySchema.make(value)
const text = (value: string) => new TextEncoder().encode(value)
const plain = FileContentTypeSchema.make("text/plain")

const runtimeLayer = Layer.mergeAll(
  fileSystemLayer({ maximumUploadBytes: ByteCountSchema.make(100) }),
  reclaimerLayer(
    FileReclaimerPolicySchema.make({
      actor,
      batchSize: MaintenanceBatchSizeSchema.make(10),
      concurrency: 1,
      retryDelayMillis: DurationMillisSchema.make(1_000),
      metadataRetentionMillis: DurationMillisSchema.make(10_000),
      changeRetentionMillis: DurationMillisSchema.make(60_000),
    }),
  ),
).pipe(
  Layer.provideMerge(
    Layer.merge(
      inMemoryLayer(),
      fixedQuotaPolicyLayer(ByteCountSchema.make(1_000)),
    ),
  ),
)

const readAll = (body: ReadableStream<Uint8Array>) =>
  Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) => cause,
  }).pipe(
    Stream.runCollect,
    Effect.map((chunks) =>
      new TextDecoder().decode(
        Uint8Array.from(Array.from(chunks).flatMap((chunk) => [...chunk])),
      ),
    ),
  )

const summarize = (changes: ReadonlyArray<FileChange>) =>
  changes.map((change) =>
    change.previousPath === null
      ? `${change.kind} ${change.path}`
      : `${change.kind} ${change.previousPath} -> ${change.path}`,
  )

describe("FileSystem bytes held by the host", () => {
  it.effect("writes, replays and reads a file with its SHA-256", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const body = text("hello")
      const written = yield* files.writeFile({
        ...context,
        parentId: null,
        name: name("hello.txt"),
        idempotencyKey: key("write-hello"),
        body,
        contentType: plain,
      })
      expect(written.size).toBe(5)
      expect(written.contentType).toBe("text/plain")
      expect(written.digest).toEqual({
        _tag: "Sha256",
        value: yield* sha256Of(body),
      })

      const replay = yield* files.writeFile({
        ...context,
        parentId: null,
        name: name("hello.txt"),
        idempotencyKey: key("write-hello"),
        body: text("hello"),
        contentType: plain,
      })
      expect(replay.id).toBe(written.id)

      const otherBytes = yield* Effect.flip(
        files.writeFile({
          ...context,
          parentId: null,
          name: name("hello.txt"),
          idempotencyKey: key("write-hello"),
          body: text("olleh"),
          contentType: plain,
        }),
      )
      expect(otherBytes._tag).toBe("IdempotencyConflict")

      const read = yield* files.readFile({ ...context, fileId: written.id })
      expect(read.file.id).toBe(written.id)
      expect(yield* readAll(read.body)).toBe("hello")

      const folder = yield* files.createFolder({
        ...context,
        parentId: null,
        name: name("folder"),
        idempotencyKey: key("folder"),
      })
      const notAFile = yield* Effect.flip(
        files.readFile({ ...context, fileId: folder.id }),
      )
      expect(notAFile._tag).toBe("FileRequired")
    }).pipe(Effect.provide(runtimeLayer)),
  )

  it.effect("rejects a larger body than the upload bound", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const tooLarge = yield* Effect.flip(
        files.writeFile({
          ...context,
          parentId: null,
          name: name("big.bin"),
          idempotencyKey: key("big"),
          body: new Uint8Array(101),
          contentType: null,
        }),
      )
      expect(tooLarge._tag).toBe("FileTooLarge")
    }).pipe(Effect.provide(runtimeLayer)),
  )
})

describe("FileSystem declared digests", () => {
  it.effect("signs the digest and media type and confirms only matching bytes", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const control = yield* FileTestControl
      const sha256 = yield* sha256Of(text("report"))
      const ticket = yield* files.requestUpload({
        ...context,
        parentId: null,
        name: name("report.txt"),
        size: ByteCountSchema.make(6),
        idempotencyKey: key("report"),
        sha256,
        contentType: plain,
      })
      const capabilities = yield* control.issuedCapabilities()
      const issued = capabilities[capabilities.length - 1]
      expect(issued?._tag === "Upload" ? issued.sha256 : null).toBe(sha256)
      expect(issued?._tag === "Upload" ? issued.contentType : null).toBe(
        "text/plain",
      )

      const replayWithoutDigest = yield* Effect.flip(
        files.requestUpload({
          ...context,
          parentId: null,
          name: name("report.txt"),
          size: ByteCountSchema.make(6),
          idempotencyKey: key("report"),
        }),
      )
      expect(replayWithoutDigest._tag).toBe("IdempotencyConflict")

      yield* control.putObject({
        fileSystemId,
        fileId: ticket.fileId,
        size: ByteCountSchema.make(6),
        contentType: plain,
        digest: { _tag: "Sha256", value: Sha256Schema.make("0".repeat(64)) },
      })
      const mismatch = yield* Effect.flip(
        files.confirmUpload({ ...context, fileId: ticket.fileId }),
      )
      expect(mismatch._tag).toBe("UploadChecksumMismatch")

      yield* control.putObject({
        fileSystemId,
        fileId: ticket.fileId,
        size: ByteCountSchema.make(6),
        contentType: plain,
        digest: { _tag: "Sha256", value: sha256 },
      })
      const ready = yield* files.confirmUpload({
        ...context,
        fileId: ticket.fileId,
      })
      expect(ready.digest).toEqual({ _tag: "Sha256", value: sha256 })
    }).pipe(Effect.provide(runtimeLayer)),
  )
})

describe("FileSystem moves", () => {
  it.effect("moves and renames folders with their subtree", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const inbox = yield* files.createFolder({
        ...context,
        parentId: null,
        name: name("inbox"),
        idempotencyKey: key("inbox"),
      })
      const archive = yield* files.createFolder({
        ...context,
        parentId: null,
        name: name("archive"),
        idempotencyKey: key("archive"),
      })
      const invoices = yield* files.createFolder({
        ...context,
        parentId: inbox.id,
        name: name("invoices"),
        idempotencyKey: key("invoices"),
      })
      const invoice = yield* files.writeFile({
        ...context,
        parentId: invoices.id,
        name: name("march.pdf"),
        idempotencyKey: key("march"),
        body: text("%PDF"),
        contentType: null,
      })

      const moved = yield* files.move({
        ...context,
        fileId: invoices.id,
        parentId: archive.id,
        name: name("2026-invoices"),
      })
      expect(moved.path).toBe("archive/2026-invoices")
      const file = yield* files.getNode({ ...context, fileId: invoice.id })
      expect(file.path).toBe("archive/2026-invoices/march.pdf")

      const unchanged = yield* files.move({
        ...context,
        fileId: invoices.id,
        parentId: archive.id,
        name: name("2026-invoices"),
      })
      expect(unchanged.updatedAt).toBe(moved.updatedAt)

      const intoItself = yield* Effect.flip(
        files.move({
          ...context,
          fileId: archive.id,
          parentId: invoices.id,
          name: name("archive"),
        }),
      )
      expect(intoItself._tag).toBe("InvalidFileInput")
      if (intoItself._tag === "InvalidFileInput") {
        expect(intoItself.reason).toBe("move_into_itself")
      }

      const conflict = yield* Effect.flip(
        files.move({
          ...context,
          fileId: archive.id,
          parentId: null,
          name: name("inbox"),
        }),
      )
      expect(conflict._tag).toBe("FileNameConflict")

      const stale = yield* Effect.flip(
        files.move({
          ...context,
          fileId: invoices.id,
          parentId: null,
          name: name("invoices"),
          expectedUpdatedAt: invoices.updatedAt,
        }),
      )
      expect(stale._tag).toBe("StaleFileNode")

      const staleDelete = yield* Effect.flip(
        files.softDelete({
          ...context,
          fileId: invoices.id,
          expectedUpdatedAt: invoices.updatedAt,
        }),
      )
      expect(staleDelete._tag).toBe("StaleFileNode")
      yield* files.softDelete({
        ...context,
        fileId: invoices.id,
        expectedUpdatedAt: moved.updatedAt,
      })
      const gone = yield* Effect.flip(
        files.getNode({ ...context, fileId: invoice.id }),
      )
      expect(gone._tag).toBe("FileNotFound")
    }).pipe(Effect.provide(runtimeLayer)),
  )
})

describe("FileSystem change log", () => {
  it.effect("reports visible changes in commit order, never pending uploads", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const reclaimer = yield* FileReclaimer
      const folder = yield* files.createFolder({
        ...context,
        parentId: null,
        name: name("docs"),
        idempotencyKey: key("docs"),
      })
      yield* files.requestUpload({
        ...context,
        parentId: folder.id,
        name: name("pending.txt"),
        size: ByteCountSchema.make(1),
        idempotencyKey: key("pending"),
      })
      yield* files.writeFile({
        ...context,
        parentId: folder.id,
        name: name("ready.txt"),
        idempotencyKey: key("ready"),
        body: text("r"),
        contentType: null,
      })
      yield* files.move({
        ...context,
        fileId: folder.id,
        parentId: null,
        name: name("papers"),
      })
      yield* files.softDelete({ ...context, fileId: folder.id })

      const first = yield* files.listChanges({
        ...context,
        after: null,
        limit: PageSizeSchema.make(3),
      })
      expect(first.more).toBe(true)
      const last = first.changes[first.changes.length - 1]?.sequence ?? null
      const rest = yield* files.listChanges({
        ...context,
        after: last,
        limit: PageSizeSchema.make(100),
      })
      expect(rest.more).toBe(false)
      expect(summarize([...first.changes, ...rest.changes])).toEqual([
        "folder_created docs",
        "file_ready docs/ready.txt",
        "node_moved docs -> papers",
        "node_moved docs/ready.txt -> papers/ready.txt",
        "node_deleted papers",
        "node_deleted papers/ready.txt",
      ])

      const other = yield* files.listChanges({
        fileSystemId: FileSystemIdSchema.make("filesystem-b"),
        actor,
        after: null,
        limit: PageSizeSchema.make(100),
      })
      expect(other.changes).toEqual([])

      expect(yield* reclaimer.nextWorkAt()).not.toBeNull()
      expect(yield* reclaimer.purgeChangesBatch()).toBe(0)
      const all = yield* files.listChanges({
        ...context,
        after: FileChangeSequenceSchema.make(1),
        limit: PageSizeSchema.make(100),
      })
      expect(all.changes.length).toBe(5)
    }).pipe(Effect.provide(runtimeLayer)),
  )
})
