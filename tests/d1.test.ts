import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { FileObjectLocatorSchema } from "../src/adapter.js"
import {
  d1FileCatalogLayer,
  makeD1FileCatalog,
  makeD1FileReclamationCatalog,
  type D1FilesDatabase,
  type D1FilesPreparedStatement,
  type D1FilesResult,
  type D1FilesSqlValue,
} from "../src/integrations/d1.js"
import {
  ByteCountSchema,
  FileActorIdSchema,
  FileActorKindSchema,
  FileActorSchema,
  FileContentTypeSchema,
  FileIdSchema,
  FileNameSchema,
  FileListTargetSchema,
  FileSystemIdSchema,
  IdempotencyKeySchema,
  MaintenanceBatchSizeSchema,
  PageSizeSchema,
  TimestampMillisSchema,
  rootListTarget,
  type FileSystemId,
} from "../src/file.js"

const migration = ["0001_files.sql", "0002_file_digests_and_changes.sql"]
  .map((name) =>
    readFileSync(new URL(`../migrations/d1/${name}`, import.meta.url), "utf8"),
  )
  .join("\n")

const actor = FileActorSchema.make({
  kind: FileActorKindSchema.make("user"),
  id: FileActorIdSchema.make("user-1"),
})
const fileSystemA = FileSystemIdSchema.make("filesystem-a")
const fileSystemB = FileSystemIdSchema.make("filesystem-b")
const bytes = (value: number) => ByteCountSchema.make(value)
const fileId = (value: string) => FileIdSchema.make(value)
const fileName = (value: string) => FileNameSchema.make(value)
const contentType = (value: string) => FileContentTypeSchema.make(value)
const idempotencyKey = (value: string) =>
  IdempotencyKeySchema.make(value)
const locator = (value: string) => FileObjectLocatorSchema.make(value)
const pageSize = (value: number) => PageSizeSchema.make(value)
const batchSize = (value: number) => MaintenanceBatchSizeSchema.make(value)
const timestamp = (value: number) => TimestampMillisSchema.make(value)
const LocalSqlValuesSchema = Schema.Array(
  Schema.Union([Schema.String, Schema.Number, Schema.Null]),
)
const LocalRawRowsSchema = Schema.Array(
  Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
)

class LocalPreparedStatement implements D1FilesPreparedStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly values: ReadonlyArray<D1FilesSqlValue> = [],
  ) {}

  bind(...values: Array<unknown>): D1FilesPreparedStatement {
    const decoded = Schema.decodeUnknownSync(LocalSqlValuesSchema)(values)
    return new LocalPreparedStatement(this.database, this.query, decoded)
  }

  first<T = unknown>(colName: string): Promise<T | null>
  first<T = Record<string, unknown>>(): Promise<T | null>
  async first<T>(colName?: string): Promise<T | null> {
    const row = this.database.prepare(this.query).get(...this.values)
    if (row === undefined) {
      return null
    }
    const result = colName === undefined ? row : row[colName]
    // SAFETY: D1's generic result methods trust the caller's selected row shape;
    // this local binding mirrors that platform boundary after SQLite execution.
    return result as T
  }

  async run<T = Record<string, unknown>>(): Promise<D1FilesResult<T>> {
    const result = this.database.prepare(this.query).run(...this.values)
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    }
  }

  async all<T = Record<string, unknown>>(): Promise<D1FilesResult<T>> {
    const rows = this.database.prepare(this.query).all(...this.values)
    return {
      success: true,
      // SAFETY: This is the same caller-selected row-shape boundary as D1.all.
      results: rows as Array<T>,
      meta: { changes: 0 },
    }
  }

  raw<T = unknown[]>(options: {
    readonly columnNames: true
  }): Promise<[string[], ...T[]]>
  raw<T = unknown[]>(options?: {
    readonly columnNames?: false
  }): Promise<T[]>
  async raw<T = unknown[]>(options?: {
    readonly columnNames?: boolean
  }): Promise<T[] | [string[], ...T[]]> {
    const statement = this.database.prepare(this.query)
    const rows = statement
      .all(...this.values)
      .map((row) => Object.values(row))
    const decoded = await Schema.decodeUnknownPromise(LocalRawRowsSchema)(rows)
    // SAFETY: D1.raw exposes a caller-selected tuple shape after positional decoding.
    const typedRows = decoded as T[]
    return options?.columnNames === true
      ? [statement.columns().map((column) => column.name), ...typedRows]
      : typedRows
  }
}

interface LocalD1 {
  readonly sqlite: DatabaseSync
  readonly binding: D1FilesDatabase
}

const openLocalD1 = (): LocalD1 => {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")
  sqlite.exec(migration)
  const binding: D1FilesDatabase = {
    prepare: (query) => new LocalPreparedStatement(sqlite, query),
    batch: async <T = unknown>(
      statements: Array<D1FilesPreparedStatement>,
    ): Promise<Array<D1FilesResult<T>>> => {
      sqlite.exec("BEGIN IMMEDIATE")
      try {
        const results: Array<D1FilesResult<T>> = []
        for (const statement of statements) {
          results.push(await statement.run<T>())
        }
        sqlite.exec("COMMIT")
        return results
      } catch (cause) {
        sqlite.exec("ROLLBACK")
        throw cause
      }
    },
  }
  return { sqlite, binding }
}

const withLocalD1 = <A, E, R>(
  use: (local: LocalD1) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(openLocalD1),
    use,
    (local) => Effect.sync(() => local.sqlite.close()),
  )

const uploadInput = (input: {
  readonly fileSystemId: FileSystemId
  readonly suffix: string
  readonly name?: string
  readonly parentId?: ReturnType<typeof fileId> | null
  readonly maximumBytes?: number
  readonly now?: number
  readonly pendingExpiresAt?: number
  readonly objectLocator?: string
}) => ({
  fileSystemId: input.fileSystemId,
  actor,
  now: timestamp(input.now ?? 1),
  id: fileId(`file-${input.suffix}`),
  parentId: input.parentId ?? null,
  name: fileName(input.name ?? `${input.suffix}.txt`),
  idempotencyKey: idempotencyKey(`upload-${input.suffix}`),
  locator: locator(input.objectLocator ?? `object:${input.suffix}`),
  maximumBytes: bytes(input.maximumBytes ?? 10),
  pendingExpiresAt: timestamp(input.pendingExpiresAt ?? 100),
  expectedSha256: null,
})

describe("D1 file catalog", () => {
  it.effect("orders Unicode names with UTF-8 binary collation", () =>
    withLocalD1((local) =>
      Effect.gen(function* () {
        const catalog = makeD1FileCatalog(local.binding)
        for (const folder of [
          { id: "unicode-emoji", name: "😀" },
          { id: "unicode-fullwidth", name: "Ｚ" },
        ]) {
          const created = yield* catalog.createFolder({
            fileSystemId: fileSystemA,
            actor,
            now: timestamp(1),
            id: fileId(folder.id),
            parentId: null,
            name: fileName(folder.name),
            idempotencyKey: idempotencyKey(`folder-${folder.id}`),
          })
          expect(created._tag).toBe("Created")
        }

        const page = yield* catalog.listChildren(
          fileSystemA,
          rootListTarget,
          { size: pageSize(100), cursor: null },
        )
        expect(
          page._tag === "Page"
            ? page.page.items.map((item) => item.name)
            : null,
        ).toEqual(["Ｚ", "😀"])
      }),
    ),
  )

  it.effect("keeps maximum-bound keyset cursors valid and resumable", () =>
    withLocalD1((local) =>
      Effect.gen(function* () {
        const catalog = makeD1FileCatalog(local.binding)
        const maximumFileSystemId = FileSystemIdSchema.make("s".repeat(200))
        const parentId = fileId("p".repeat(200))
        const parent = yield* catalog.createFolder({
          fileSystemId: maximumFileSystemId,
          actor,
          now: timestamp(1),
          id: parentId,
          parentId: null,
          name: fileName("p"),
          idempotencyKey: idempotencyKey("folder-maximum-parent"),
        })
        if (parent._tag !== "Created") {
          return yield* Effect.die("expected maximum cursor parent")
        }
        for (const child of [
          { id: "a".repeat(200), name: "界".repeat(255) },
          { id: "b".repeat(200), name: "龘".repeat(255) },
        ]) {
          const created = yield* catalog.createFolder({
            fileSystemId: maximumFileSystemId,
            actor,
            now: timestamp(2),
            id: fileId(child.id),
            parentId,
            name: fileName(child.name),
            idempotencyKey: idempotencyKey(
              `folder-child-${child.id.slice(0, 1)}`,
            ),
          })
          expect(created._tag).toBe("Created")
        }

        const target = FileListTargetSchema.cases.FolderId.make({ id: parentId })
        const first = yield* catalog.listChildren(
          maximumFileSystemId,
          target,
          { size: pageSize(1), cursor: null },
        )
        if (first._tag !== "Page" || first.page.cursor === null) {
          return yield* Effect.die("expected maximum-bound cursor")
        }
        expect(first.page.cursor.length).toBeLessThanOrEqual(4096)

        const second = yield* catalog.listChildren(
          maximumFileSystemId,
          target,
          { size: pageSize(1), cursor: first.page.cursor },
        )
        expect(
          second._tag === "Page"
            ? second.page.items.map((item) => item.name)
            : null,
        ).toEqual(["龘".repeat(255)])
      }),
    ),
  )

  it.effect("enforces lifecycle, parent, locator, and filesystem boundaries", () =>
    withLocalD1((local) =>
      Effect.gen(function* () {
        const catalog = makeD1FileCatalog(local.binding)
        const beta = yield* catalog.createFolder({
          fileSystemId: fileSystemA,
          actor,
          now: timestamp(1),
          id: fileId("folder-beta"),
          parentId: null,
          name: fileName("beta"),
          idempotencyKey: idempotencyKey("folder-beta"),
        })
        const alpha = yield* catalog.createFolder({
          fileSystemId: fileSystemA,
          actor,
          now: timestamp(2),
          id: fileId("folder-alpha"),
          parentId: null,
          name: fileName("alpha"),
          idempotencyKey: idempotencyKey("folder-alpha"),
        })
        const file = yield* catalog.reserveUpload(
          uploadInput({
            fileSystemId: fileSystemA,
            suffix: "aardvark",
            now: 3,
            pendingExpiresAt: 30,
          }),
        )
        if (
          beta._tag !== "Created" ||
          alpha._tag !== "Created" ||
          file._tag !== "Created"
        ) {
          return yield* Effect.die("expected fixture creation")
        }

        const first = yield* catalog.listChildren(
          fileSystemA,
          rootListTarget,
          { size: pageSize(2), cursor: null },
        )
        if (first._tag !== "Page" || first.page.cursor === null) {
          return yield* Effect.die("expected a first page")
        }
        expect(first.page.items.map((node) => node.name)).toEqual([
          "alpha",
          "beta",
        ])
        const sameIdInOtherFileSystem = yield* catalog.createFolder({
          fileSystemId: fileSystemB,
          actor,
          now: timestamp(3),
          id: beta.node.id,
          parentId: null,
          name: fileName("beta"),
          idempotencyKey: idempotencyKey("folder-beta"),
        })
        expect(sameIdInOtherFileSystem._tag).toBe("Created")
        const crossFileSystemCursor = yield* catalog.listChildren(
          fileSystemB,
          rootListTarget,
          { size: pageSize(2), cursor: first.page.cursor },
        )
        expect(crossFileSystemCursor._tag).toBe("InvalidCursor")

        const deletedAnchor = yield* catalog.softDelete({
          fileSystemId: fileSystemA,
          actor,
          now: timestamp(4),
          fileId: beta.node.id,
          reclaimAfter: timestamp(100),
          expectedUpdatedAt: null,
        })
        expect(deletedAnchor._tag).toBe("Deleted")
        const second = yield* catalog.listChildren(
          fileSystemA,
          rootListTarget,
          { size: pageSize(2), cursor: first.page.cursor },
        )
        if (second._tag !== "Page") {
          return yield* Effect.die("expected a second page")
        }
        expect(second.page.items.map((node) => node.name)).toEqual([
          "aardvark.txt",
        ])
        const isolated = yield* catalog.listChildren(
          fileSystemB,
          rootListTarget,
          { size: pageSize(100), cursor: null },
        )
        expect(isolated._tag === "Page" ? isolated.page.items : null).toEqual(
          [sameIdInOtherFileSystem._tag === "Created" ? sameIdInOtherFileSystem.node : null],
        )

        expect(() =>
          local.sqlite
            .prepare(
              "UPDATE popcomputer_files SET parent_id = ? WHERE file_system_id = ? AND id = ?",
            )
            .run(file.node.id, fileSystemA, alpha.node.id),
        ).toThrow(/parent must be a live folder/u)
        expect(() =>
          local.sqlite
            .prepare(
              "UPDATE popcomputer_files SET maximum_bytes = NULL WHERE file_system_id = ? AND id = ?",
            )
            .run(fileSystemA, file.node.id),
        ).toThrow()
        expect(() =>
          local.sqlite
            .prepare(
              "UPDATE popcomputer_file_upload_requests SET requested_name = 'changed.txt' WHERE file_system_id = ?",
            )
            .run(fileSystemA),
        ).toThrow(/immutable/u)
        expect(() =>
          local.sqlite
            .prepare(
              "UPDATE popcomputer_file_folder_requests SET requested_name = 'changed' WHERE file_system_id = ?",
            )
            .run(fileSystemA),
        ).toThrow(/immutable/u)

        const duplicateLocator = yield* Effect.result(
          catalog.reserveUpload(
            uploadInput({
              fileSystemId: fileSystemB,
              suffix: "duplicate-locator",
              objectLocator: "object:aardvark",
              now: 4,
              pendingExpiresAt: 40,
            }),
          ),
        )
        expect(Result.isFailure(duplicateLocator)).toBe(true)
      }),
    ),
  )

  it.effect("keeps folder-create replay durable across deletion and metadata purge", () =>
    withLocalD1((local) =>
      Effect.gen(function* () {
        const catalog = makeD1FileCatalog(local.binding)
        const reclamation = makeD1FileReclamationCatalog(local.binding)
        const original = {
          fileSystemId: fileSystemA,
          actor,
          now: timestamp(10),
          id: fileId("folder-durable"),
          parentId: null,
          name: fileName("documents"),
          idempotencyKey: idempotencyKey("folder-durable"),
        }

        const created = yield* catalog.createFolder(original)
        if (created._tag !== "Created") {
          return yield* Effect.die("expected folder creation")
        }

        const sameKeyInUploadNamespace = yield* catalog.reserveUpload({
          ...uploadInput({
            fileSystemId: fileSystemA,
            suffix: "same-key-different-command-kind",
          }),
          idempotencyKey: original.idempotencyKey,
        })
        expect(sameKeyInUploadNamespace._tag).toBe("Created")

        const replay = yield* catalog.createFolder({
          ...original,
          now: timestamp(11),
          id: fileId("ignored-folder-replay-id"),
        })
        expect(replay._tag).toBe("ReplayFolder")
        if (replay._tag === "ReplayFolder") {
          expect(replay.node.id).toBe(created.node.id)
        }

        const changedFingerprint = yield* catalog.createFolder({
          ...original,
          now: timestamp(12),
          id: fileId("ignored-folder-conflict-id"),
          name: fileName("other"),
        })
        expect(changedFingerprint._tag).toBe("IdempotencyConflict")

        expect(
          (
            yield* catalog.softDelete({
              fileSystemId: fileSystemA,
              actor,
              now: timestamp(20),
              fileId: created.node.id,
              reclaimAfter: timestamp(20),
              expectedUpdatedAt: null,
            })
          )._tag,
        ).toBe("Deleted")
        const deletedReplay = yield* catalog.createFolder({
          ...original,
          now: timestamp(21),
          id: fileId("ignored-folder-deleted-id"),
        })
        expect(deletedReplay).toEqual({
          _tag: "ReplayUnavailable",
          fileId: created.node.id,
        })

        expect(
          yield* reclamation.purgeReclaimedBatch({
            deletedBefore: timestamp(20),
            limit: batchSize(10),
          }),
        ).toBe(1)
        const folderRows = local.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM popcomputer_file_folder_requests WHERE file_system_id = ?",
          )
          .get(fileSystemA) as { readonly count: number }
        expect(folderRows.count).toBe(1)

        const purgedReplay = yield* catalog.createFolder({
          ...original,
          now: timestamp(30),
          id: fileId("ignored-folder-purged-id"),
        })
        expect(purgedReplay).toEqual({
          _tag: "ReplayUnavailable",
          fileId: created.node.id,
        })

        const replacement = yield* catalog.createFolder({
          ...original,
          now: timestamp(31),
          id: fileId("folder-replacement"),
          idempotencyKey: idempotencyKey("folder-replacement"),
        })
        expect(replacement._tag).toBe("Created")
      }),
    ),
  )

  it.effect("keeps replay durable across rename, deletion, and metadata purge", () =>
    withLocalD1((local) =>
      Effect.gen(function* () {
        const catalog = makeD1FileCatalog(local.binding)
        const reclamation = makeD1FileReclamationCatalog(local.binding)
        const original = uploadInput({
          fileSystemId: fileSystemA,
          suffix: "durable",
          name: "original.txt",
          now: 10,
          pendingExpiresAt: 100,
        })
        const created = yield* catalog.reserveUpload(original)
        if (created._tag !== "Created") {
          return yield* Effect.die("expected upload reservation")
        }

        const renamed = yield* catalog.move({
          fileSystemId: fileSystemA,
          actor,
          now: timestamp(20),
          fileId: created.node.id,
          parentId: null,
          name: fileName("renamed.txt"),
          expectedUpdatedAt: null,
        })
        expect(renamed._tag).toBe("Moved")
        const pendingReplay = yield* catalog.reserveUpload({
          ...original,
          id: fileId("ignored-replay-id"),
          locator: locator("object:ignored-replay"),
          now: timestamp(21),
          pendingExpiresAt: timestamp(150),
        })
        if (pendingReplay._tag !== "ReplayPending") {
          return yield* Effect.die("expected pending replay")
        }
        expect(pendingReplay.node.id).toBe(created.node.id)
        expect(pendingReplay.node.name).toBe("renamed.txt")
        expect(pendingReplay.node.pendingExpiresAt).toBe(150)

        const renamedFingerprint = yield* catalog.reserveUpload({
          ...original,
          id: fileId("ignored-conflict-id"),
          name: fileName("renamed.txt"),
          locator: locator("object:ignored-conflict"),
          now: timestamp(22),
          pendingExpiresAt: timestamp(160),
        })
        expect(renamedFingerprint._tag).toBe("IdempotencyConflict")

        const confirmed = yield* catalog.confirmUpload({
          fileSystemId: fileSystemA,
          actor,
          now: timestamp(30),
          fileId: created.node.id,
          size: bytes(4),
          contentType: contentType("text/plain"),
          digest: null,
          quotaBytes: bytes(10),
        })
        expect(confirmed._tag).toBe("Confirmed")
        const readyReplay = yield* catalog.reserveUpload({
          ...original,
          id: fileId("ignored-ready-id"),
          locator: locator("object:ignored-ready"),
          now: timestamp(31),
          pendingExpiresAt: timestamp(170),
        })
        expect(readyReplay._tag).toBe("ReplayReady")

        const deleted = yield* catalog.softDelete({
          fileSystemId: fileSystemA,
          actor,
          now: timestamp(40),
          fileId: created.node.id,
          reclaimAfter: timestamp(200),
          expectedUpdatedAt: null,
        })
        expect(deleted._tag).toBe("Deleted")
        const deletedReplay = yield* catalog.reserveUpload({
          ...original,
          id: fileId("ignored-deleted-id"),
          locator: locator("object:ignored-deleted"),
          now: timestamp(41),
          pendingExpiresAt: timestamp(180),
        })
        expect(deletedReplay).toEqual({
          _tag: "ReplayUnavailable",
          fileId: created.node.id,
        })

        expect(
          yield* reclamation.listReclaimable({
            now: timestamp(199),
            limit: batchSize(10),
          }),
        ).toEqual([])
        const candidates = yield* reclamation.listReclaimable({
          now: timestamp(200),
          limit: batchSize(10),
        })
        expect(candidates).toHaveLength(1)
        const candidate = candidates[0]
        if (candidate === undefined) {
          return yield* Effect.die("expected reclamation candidate")
        }
        yield* reclamation.completeReclamation({
          candidate,
          now: timestamp(200),
        })
        expect(
          yield* reclamation.purgeReclaimedBatch({
            deletedBefore: timestamp(40),
            limit: batchSize(10),
          }),
        ).toBe(1)

        const fileRows = local.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM popcomputer_files WHERE file_system_id = ?",
          )
          .get(fileSystemA) as { readonly count: number }
        const ledgerRows = local.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM popcomputer_file_upload_requests WHERE file_system_id = ?",
          )
          .get(fileSystemA) as { readonly count: number }
        expect(fileRows.count).toBe(0)
        expect(ledgerRows.count).toBe(1)

        const purgedReplay = yield* catalog.reserveUpload({
          ...original,
          id: fileId("ignored-purged-id"),
          locator: locator("object:ignored-purged"),
          now: timestamp(210),
          pendingExpiresAt: timestamp(300),
        })
        expect(purgedReplay._tag).toBe("ReplayUnavailable")

        const replacement = yield* catalog.reserveUpload(
          uploadInput({
            fileSystemId: fileSystemA,
            suffix: "replacement",
            name: "renamed.txt",
            now: 211,
            pendingExpiresAt: 300,
          }),
        )
        expect(replacement._tag).toBe("Created")
      }),
    ),
  )

  it.effect("expires, defers, lists, completes, and purges bounded batches", () =>
    withLocalD1((local) =>
      Effect.gen(function* () {
        const catalog = makeD1FileCatalog(local.binding)
        const reclamation = makeD1FileReclamationCatalog(local.binding)
        for (const [suffix, expiry] of [
          ["expires-first", 10],
          ["expires-second", 20],
          ["stays-live", 100],
        ] as const) {
          const result = yield* catalog.reserveUpload(
            uploadInput({
              fileSystemId: fileSystemA,
              suffix,
              pendingExpiresAt: expiry,
            }),
          )
          expect(result._tag).toBe("Created")
        }

        expect(
          yield* reclamation.expirePendingBatch({
            actor,
            now: timestamp(50),
            reclaimAfter: timestamp(60),
            limit: batchSize(1),
          }),
        ).toBe(1)
        expect(
          yield* reclamation.expirePendingBatch({
            actor,
            now: timestamp(50),
            reclaimAfter: timestamp(60),
            limit: batchSize(1),
          }),
        ).toBe(1)
        expect(
          yield* reclamation.expirePendingBatch({
            actor,
            now: timestamp(50),
            reclaimAfter: timestamp(60),
            limit: batchSize(1),
          }),
        ).toBe(0)
        expect(
          yield* reclamation.listReclaimable({
            now: timestamp(59),
            limit: batchSize(10),
          }),
        ).toEqual([])

        const firstPage = yield* reclamation.listReclaimable({
          now: timestamp(60),
          limit: batchSize(1),
        })
        expect(firstPage).toHaveLength(1)
        const deferred = firstPage[0]
        if (deferred === undefined) {
          return yield* Effect.die("expected bounded reclamation candidate")
        }
        yield* reclamation.deferReclamation({
          candidate: deferred,
          retryAt: timestamp(90),
        })

        const remaining = yield* reclamation.listReclaimable({
          now: timestamp(60),
          limit: batchSize(10),
        })
        expect(remaining).toHaveLength(1)
        const completed = remaining[0]
        if (completed === undefined) {
          return yield* Effect.die("expected remaining reclamation candidate")
        }
        yield* reclamation.completeReclamation({
          candidate: completed,
          now: timestamp(60),
        })
        expect(
          yield* reclamation.purgeReclaimedBatch({
            deletedBefore: timestamp(50),
            limit: batchSize(1),
          }),
        ).toBe(1)
        expect(
          yield* reclamation.listReclaimable({
            now: timestamp(89),
            limit: batchSize(10),
          }),
        ).toEqual([])
        expect(
          yield* reclamation.listReclaimable({
            now: timestamp(90),
            limit: batchSize(10),
          }),
        ).toEqual([deferred])

        const live = yield* catalog.get(
          fileSystemA,
          fileId("file-stays-live"),
        )
        expect(live?._tag).toBe("PendingFile")
      }),
    ),
  )

  it.effect("applies quota within one filesystem and independently across filesystems", () =>
    withLocalD1((local) =>
      Effect.gen(function* () {
        const catalog = makeD1FileCatalog(local.binding)
        const first = yield* catalog.reserveUpload(
          uploadInput({
            fileSystemId: fileSystemA,
            suffix: "quota-first",
            maximumBytes: 4,
          }),
        )
        const second = yield* catalog.reserveUpload(
          uploadInput({
            fileSystemId: fileSystemA,
            suffix: "quota-second",
            maximumBytes: 2,
          }),
        )
        const independent = yield* catalog.reserveUpload(
          uploadInput({
            fileSystemId: fileSystemB,
            suffix: "quota-independent",
            maximumBytes: 2,
          }),
        )
        if (
          first._tag !== "Created" ||
          second._tag !== "Created" ||
          independent._tag !== "Created"
        ) {
          return yield* Effect.die("expected quota fixtures")
        }

        expect(
          (
            yield* catalog.confirmUpload({
              fileSystemId: fileSystemA,
              actor,
              now: timestamp(10),
              fileId: first.node.id,
              size: bytes(4),
              contentType: null,
              digest: null,
              quotaBytes: bytes(5),
            })
          )._tag,
        ).toBe("Confirmed")
        expect(
          (
            yield* catalog.confirmUpload({
              fileSystemId: fileSystemA,
              actor,
              now: timestamp(11),
              fileId: second.node.id,
              size: bytes(2),
              contentType: null,
              digest: null,
              quotaBytes: bytes(5),
            })
          )._tag,
        ).toBe("QuotaExceeded")
        expect(
          (
            yield* catalog.confirmUpload({
              fileSystemId: fileSystemB,
              actor,
              now: timestamp(12),
              fileId: independent.node.id,
              size: bytes(2),
              contentType: null,
              digest: null,
              quotaBytes: bytes(5),
            })
          )._tag,
        ).toBe("Confirmed")
      }),
    ),
  )

  it.effect("does not leave ledger or node orphans after expected conflicts", () =>
    withLocalD1((local) =>
      Effect.gen(function* () {
        const catalog = makeD1FileCatalog(local.binding)
        const original = uploadInput({
          fileSystemId: fileSystemA,
          suffix: "atomic",
          name: "claimed.txt",
        })
        expect((yield* catalog.reserveUpload(original))._tag).toBe("Created")

        const keyConflict = yield* catalog.reserveUpload({
          ...original,
          id: fileId("file-key-conflict"),
          name: fileName("different.txt"),
          locator: locator("object:key-conflict"),
        })
        expect(keyConflict._tag).toBe("IdempotencyConflict")
        const nameConflict = yield* catalog.reserveUpload(
          uploadInput({
            fileSystemId: fileSystemA,
            suffix: "name-conflict",
            name: "claimed.txt",
          }),
        )
        expect(nameConflict._tag).toBe("NameConflict")

        const fileCount = local.sqlite
          .prepare("SELECT COUNT(*) AS count FROM popcomputer_files")
          .get() as { readonly count: number }
        const ledgerCount = local.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM popcomputer_file_upload_requests",
          )
          .get() as { readonly count: number }
        expect(fileCount.count).toBe(1)
        expect(ledgerCount.count).toBe(1)

        const otherFilesystem = yield* catalog.reserveUpload({
          ...original,
          fileSystemId: fileSystemB,
          id: fileId("file-other-filesystem"),
          locator: locator("object:other-filesystem"),
        })
        expect(otherFilesystem._tag).toBe("Created")
      }),
    ),
  )

  it.effect("provides both D1 catalog capabilities in one Layer", () =>
    withLocalD1((local) =>
      Effect.sync(() => {
        expect(d1FileCatalogLayer(local.binding)).toBeDefined()
      }),
    ),
  )
})

describe("D1 moves, deletes and change log", () => {
  const folder = (
    catalog: ReturnType<typeof makeD1FileCatalog>,
    id: string,
    parentId: string | null,
    now: number,
  ) =>
    catalog
      .createFolder({
        fileSystemId: fileSystemA,
        actor,
        now: timestamp(now),
        id: fileId(id),
        parentId: parentId === null ? null : fileId(parentId),
        name: fileName(id),
        idempotencyKey: idempotencyKey(`folder-${id}`),
      })
      .pipe(
        Effect.flatMap((result) =>
          result._tag === "Created"
            ? Effect.succeed(result.node)
            : Effect.die(`expected folder ${id}, got ${result._tag}`),
        ),
      )

  const readyFile = (
    catalog: ReturnType<typeof makeD1FileCatalog>,
    suffix: string,
    parentId: string,
    now: number,
  ) =>
    Effect.gen(function* () {
      const reserved = yield* catalog.reserveUpload(
        uploadInput({
          fileSystemId: fileSystemA,
          suffix,
          parentId: fileId(parentId),
          now,
        }),
      )
      if (reserved._tag !== "Created") {
        return yield* Effect.die("expected reservation")
      }
      const confirmed = yield* catalog.confirmUpload({
        fileSystemId: fileSystemA,
        actor,
        now: timestamp(now + 1),
        fileId: reserved.node.id,
        size: bytes(1),
        contentType: null,
        digest: null,
        quotaBytes: bytes(1_000),
      })
      if (confirmed._tag !== "Confirmed") {
        return yield* Effect.die("expected confirmation")
      }
      return confirmed.node
    })

  const moveInput = (
    id: string,
    parentId: string | null,
    name: string,
    now: number,
    expectedUpdatedAt: number | null = null,
  ) => ({
    fileSystemId: fileSystemA,
    actor,
    now: timestamp(now),
    fileId: fileId(id),
    parentId: parentId === null ? null : fileId(parentId),
    name: fileName(name),
    expectedUpdatedAt:
      expectedUpdatedAt === null ? null : timestamp(expectedUpdatedAt),
  })

  it.effect("moves a folder subtree in one statement and logs each visible node", () =>
    withLocalD1((local) =>
      Effect.gen(function* () {
        const catalog = makeD1FileCatalog(local.binding)
        yield* folder(catalog, "a", null, 1)
        yield* folder(catalog, "b", "a", 2)
        yield* folder(catalog, "c", null, 3)
        const file = yield* readyFile(catalog, "f", "b", 4)
        yield* catalog.reserveUpload(
          uploadInput({
            fileSystemId: fileSystemA,
            suffix: "pending",
            parentId: fileId("b"),
            now: 6,
          }),
        )

        const moved = yield* catalog.move(moveInput("a", "c", "a2", 10))
        expect(moved._tag).toBe("Moved")
        const paths = local.sqlite
          .prepare(
            "SELECT id, path FROM popcomputer_files WHERE deleted_at IS NULL ORDER BY path",
          )
          .all()
          .map((row) => `${String(row["id"])}:${String(row["path"])}`)
        expect(paths).toEqual([
          "c:c",
          "a:c/a2",
          "b:c/a2/b",
          `${file.id}:c/a2/b/f.txt`,
          "file-pending:c/a2/b/pending.txt",
        ])

        const page = yield* catalog.listChanges(fileSystemA, null, pageSize(100))
        const described = page.changes.map((change) =>
          change.previousPath === null
            ? `${change.kind} ${change.path}`
            : `${change.kind} ${change.previousPath} -> ${change.path}`,
        )
        expect(described.slice(0, 4)).toEqual([
          "folder_created a",
          "folder_created a/b",
          "folder_created c",
          "file_ready a/b/f.txt",
        ])
        // One statement's rows are logged in the engine's row order.
        expect(described.slice(4).sort()).toEqual([
          "node_moved a -> c/a2",
          "node_moved a/b -> c/a2/b",
          "node_moved a/b/f.txt -> c/a2/b/f.txt",
        ])
        expect(page.more).toBe(false)
        expect(
          (yield* catalog.listChanges(fileSystemB, null, pageSize(100)))
            .changes,
        ).toEqual([])
      }),
    ),
  )

  it.effect("rejects cycles, conflicts, stale moves and over-deep subtrees", () =>
    withLocalD1((local) =>
      Effect.gen(function* () {
        const catalog = makeD1FileCatalog(local.binding)
        const a = yield* folder(catalog, "a", null, 1)
        yield* folder(catalog, "b", "a", 2)
        yield* folder(catalog, "x", null, 3)

        expect((yield* catalog.move(moveInput("a", "b", "a", 10)))._tag).toBe(
          "Cycle",
        )
        expect((yield* catalog.move(moveInput("a", "a", "a", 10)))._tag).toBe(
          "Cycle",
        )
        expect((yield* catalog.move(moveInput("a", null, "x", 10)))._tag).toBe(
          "NameConflict",
        )
        expect(
          (yield* catalog.move(moveInput("a", null, "a3", 10, a.updatedAt + 5)))
            ._tag,
        ).toBe("Stale")
        expect((yield* catalog.move(moveInput("a", null, "a", 10)))._tag).toBe(
          "Unchanged",
        )

        let parent: string | null = null
        for (let depth = 1; depth <= 31; depth += 1) {
          const id = `d${depth}`
          yield* folder(catalog, id, parent, 20 + depth)
          parent = id
        }
        expect((yield* catalog.move(moveInput("x", "d31", "x", 60)))._tag).toBe(
          "Moved",
        )
        expect((yield* catalog.move(moveInput("a", "d30", "a", 61)))._tag).toBe(
          "Moved",
        )
        expect((yield* catalog.move(moveInput("a", "d31", "a", 62)))._tag).toBe(
          "InvalidPath",
        )
      }),
    ),
  )

  it.effect("deletes the subtree a node heads when it is deleted, even after a move", () =>
    withLocalD1((local) =>
      Effect.gen(function* () {
        const catalog = makeD1FileCatalog(local.binding)
        yield* folder(catalog, "p", null, 1)
        yield* folder(catalog, "q", null, 2)
        yield* readyFile(catalog, "child", "p", 3)
        const moved = yield* catalog.move(moveInput("p", "q", "p", 10))
        if (moved._tag !== "Moved") return yield* Effect.die("expected move")

        const stale = yield* catalog.softDelete({
          fileSystemId: fileSystemA,
          actor,
          now: timestamp(20),
          fileId: fileId("p"),
          reclaimAfter: timestamp(100),
          expectedUpdatedAt: timestamp(1),
        })
        expect(stale._tag).toBe("Stale")

        const deleted = yield* catalog.softDelete({
          fileSystemId: fileSystemA,
          actor,
          now: timestamp(21),
          fileId: fileId("p"),
          reclaimAfter: timestamp(100),
          expectedUpdatedAt: moved.node.updatedAt,
        })
        expect(deleted._tag).toBe("Deleted")
        const live = local.sqlite
          .prepare(
            "SELECT path FROM popcomputer_files WHERE deleted_at IS NULL ORDER BY path",
          )
          .all()
          .map((row) => String(row["path"]))
        expect(live).toEqual(["q"])

        const changes = yield* catalog.listChanges(
          fileSystemA,
          null,
          pageSize(100),
        )
        expect(
          changes.changes
            .filter((change) => change.kind === "node_deleted")
            .map((change) => change.path)
            .sort(),
        ).toEqual(["q/p", "q/p/child.txt"])
      }),
    ),
  )

  it.effect("reports maintenance due times and purges old changes", () =>
    withLocalD1((local) =>
      Effect.gen(function* () {
        const catalog = makeD1FileCatalog(local.binding)
        const reclamation = makeD1FileReclamationCatalog(local.binding)
        expect(yield* reclamation.maintenanceDue()).toEqual({
          pendingExpiresAt: null,
          reclaimAfter: null,
          reclaimedDeletedAt: null,
          oldestChangeAt: null,
        })
        yield* folder(catalog, "f", null, 5)
        yield* catalog.reserveUpload(
          uploadInput({
            fileSystemId: fileSystemA,
            suffix: "due",
            now: 6,
            pendingExpiresAt: 50,
          }),
        )
        expect(yield* reclamation.maintenanceDue()).toEqual({
          pendingExpiresAt: 50,
          reclaimAfter: null,
          reclaimedDeletedAt: null,
          oldestChangeAt: 5,
        })
        expect(
          yield* reclamation.purgeChangesBatch({
            recordedBefore: timestamp(5),
            limit: batchSize(10),
          }),
        ).toBe(0)
        expect(
          yield* reclamation.purgeChangesBatch({
            recordedBefore: timestamp(6),
            limit: batchSize(10),
          }),
        ).toBe(1)
        yield* folder(catalog, "g", null, 7)
        const after = yield* catalog.listChanges(fileSystemA, null, pageSize(10))
        expect(after.changes.map((change) => change.sequence)).toEqual([2])
      }),
    ),
  )
})
