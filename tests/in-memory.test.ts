import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Layer } from "effect"
import { FileReclamationCatalog } from "../src/adapter.js"
import {
  FileSystem,
  fixedQuotaPolicyLayer,
  layer as fileSystemLayer,
  quotaPolicyLayer,
} from "../src/file-system.js"
import { FileQuotaPolicyUnavailable } from "../src/errors.js"
import {
  ByteCountSchema,
  FileActorIdSchema,
  FileActorKindSchema,
  FileActorSchema,
  FileContentTypeSchema,
  FileListTargetSchema,
  FileNameSchema,
  FileSystemIdSchema,
  IdempotencyKeySchema,
  MaintenanceBatchSizeSchema,
  PageCursorSchema,
  PageSizeSchema,
  RelativePathSchema,
  TimestampMillisSchema,
  rootListTarget,
} from "../src/file.js"
import { layer as inMemoryLayer } from "../src/in-memory.js"
import { FileTestControl } from "../src/testing.js"

const actor = FileActorSchema.make({
  kind: FileActorKindSchema.make("user"),
  id: FileActorIdSchema.make("user-1"),
})

const fileSystemA = FileSystemIdSchema.make("filesystem-a")
const fileSystemB = FileSystemIdSchema.make("filesystem-b")
const fileSystemC = FileSystemIdSchema.make("filesystem-c")

const bytes = (value: number) => ByteCountSchema.make(value)
const name = (value: string) => FileNameSchema.make(value)
const contentType = (value: string) => FileContentTypeSchema.make(value)
const key = (value: string) => IdempotencyKeySchema.make(value)
const pageSize = (value: number) => PageSizeSchema.make(value)

const fullPage = {
  size: pageSize(100),
  cursor: null,
}

const runtimeLayer = (quotaBytes: number, maximumUploadBytes = 100) =>
  fileSystemLayer({
    maximumUploadBytes: bytes(maximumUploadBytes),
  }).pipe(
    Layer.provideMerge(
      Layer.merge(
        inMemoryLayer(),
        fixedQuotaPolicyLayer(bytes(quotaBytes)),
      ),
    ),
  )

const unavailableQuotaRuntimeLayer = fileSystemLayer({
  maximumUploadBytes: bytes(100),
}).pipe(
  Layer.provideMerge(
    Layer.merge(
      inMemoryLayer(),
      quotaPolicyLayer({
        quotaBytesFor: () =>
          Effect.fail(
            new FileQuotaPolicyUnavailable({
              operation: "quotaBytesFor",
              cause: new Error("quota policy unavailable in test"),
            }),
          ),
      }),
    ),
  ),
)

describe("in-memory FileSystem", () => {
  it.effect("isolates filesystems and lists root, folder, and path targets", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem

      const documents = yield* files.createFolder({
        fileSystemId: fileSystemA,
        actor,
        parentId: null,
        name: name("documents"),
        idempotencyKey: key("folder-documents"),
      })
      const reports = yield* files.createFolder({
        fileSystemId: fileSystemA,
        actor,
        parentId: documents.id,
        name: name("reports"),
        idempotencyKey: key("folder-reports"),
      })
      const upload = yield* files.requestUpload({
        fileSystemId: fileSystemA,
        actor,
        parentId: reports.id,
        name: name("quarterly.txt"),
        size: bytes(4),
        idempotencyKey: key("quarterly-upload"),
      })

      const root = yield* files.listChildren({
        fileSystemId: fileSystemA,
        actor,
        target: rootListTarget,
        page: fullPage,
      })
      const folder = yield* files.listChildren({
        fileSystemId: fileSystemA,
        actor,
        target: FileListTargetSchema.cases.FolderId.make({
          id: documents.id,
        }),
        page: fullPage,
      })
      const path = yield* files.listChildren({
        fileSystemId: fileSystemA,
        actor,
        target: FileListTargetSchema.cases.Path.make({
          path: RelativePathSchema.make("documents/reports"),
        }),
        page: fullPage,
      })
      const otherFileSystem = yield* files.listChildren({
        fileSystemId: fileSystemB,
        actor,
        target: rootListTarget,
        page: fullPage,
      })
      const thirdFileSystem = yield* files.listChildren({
        fileSystemId: fileSystemC,
        actor,
        target: rootListTarget,
        page: fullPage,
      })

      expect(root.items.map((node) => node.name)).toEqual(["documents"])
      expect(folder.items.map((node) => node.name)).toEqual(["reports"])
      expect(path.items.map((node) => node.name)).toEqual(["quarterly.txt"])
      expect(otherFileSystem.items).toEqual([])
      expect(thirdFileSystem.items).toEqual([])

      const fileTargetError = yield* Effect.flip(
        files.listChildren({
          fileSystemId: fileSystemA,
          actor,
          target: FileListTargetSchema.cases.FolderId.make({ id: upload.fileId }),
          page: fullPage,
        }),
      )
      expect(fileTargetError._tag).toBe("FolderRequired")
    }).pipe(Effect.provide(runtimeLayer(100))),
  )

  it.effect("uses stable folder-first keyset cursors and enforces sibling names", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem

      for (const folderName of ["alpha", "bravo", "charlie"]) {
        yield* files.createFolder({
          fileSystemId: fileSystemA,
          actor,
          parentId: null,
          name: name(folderName),
          idempotencyKey: key(`folder-${folderName}`),
        })
      }
      yield* files.requestUpload({
        fileSystemId: fileSystemA,
        actor,
        parentId: null,
        name: name("aardvark.txt"),
        size: bytes(1),
        idempotencyKey: key("file-after-folders"),
      })

      const crossKindConflict = yield* Effect.flip(
        files.requestUpload({
          fileSystemId: fileSystemA,
          actor,
          parentId: null,
          name: name("alpha"),
          size: bytes(1),
          idempotencyKey: key("cross-kind-conflict"),
        }),
      )
      expect(crossKindConflict._tag).toBe("FileNameConflict")

      const first = yield* files.listChildren({
        fileSystemId: fileSystemA,
        actor,
        target: rootListTarget,
        page: { size: pageSize(2), cursor: null },
      })
      expect(first.items.map((node) => node.name)).toEqual(["alpha", "bravo"])
      if (first.cursor === null) {
        return yield* Effect.die("expected a continuation cursor")
      }

      const crossFileSystemCursor = yield* Effect.flip(
        files.listChildren({
          fileSystemId: fileSystemB,
          actor,
          target: rootListTarget,
          page: { size: pageSize(10), cursor: first.cursor },
        }),
      )
      expect(crossFileSystemCursor._tag).toBe("InvalidFileInput")

      yield* files.createFolder({
        fileSystemId: fileSystemA,
        actor,
        parentId: null,
        name: name("aardvark"),
        idempotencyKey: key("folder-aardvark"),
      })
      const second = yield* files.listChildren({
        fileSystemId: fileSystemA,
        actor,
        target: rootListTarget,
        page: { size: pageSize(100), cursor: first.cursor },
      })
      expect(second.items.map((node) => node.name)).toEqual([
        "charlie",
        "aardvark.txt",
      ])
      expect(second.cursor).toBeNull()

      const invalidCursor = yield* Effect.flip(
        files.listChildren({
          fileSystemId: fileSystemA,
          actor,
          target: rootListTarget,
          page: {
            size: pageSize(10),
            cursor: PageCursorSchema.make("not-json"),
          },
        }),
      )
      expect(invalidCursor._tag).toBe("InvalidFileInput")
      if (invalidCursor._tag === "InvalidFileInput") {
        expect(invalidCursor.reason).toBe("invalid_cursor")
      }
    }).pipe(Effect.provide(runtimeLayer(100))),
  )

  it.effect("orders Unicode names with the catalog's UTF-8 binary collation", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      for (const folderName of ["😀", "Ｚ"]) {
        yield* files.createFolder({
          fileSystemId: fileSystemA,
          actor,
          parentId: null,
          name: name(folderName),
          idempotencyKey: key(
            folderName === "😀"
              ? "unicode-folder-emoji"
              : "unicode-folder-fullwidth",
          ),
        })
      }

      const page = yield* files.listChildren({
        fileSystemId: fileSystemA,
        actor,
        target: rootListTarget,
        page: fullPage,
      })
      expect(page.items.map((node) => node.name)).toEqual(["Ｚ", "😀"])
    }).pipe(Effect.provide(runtimeLayer(100))),
  )

  it.effect("keeps folder replay identity across deletion and metadata purge", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const reclamation = yield* FileReclamationCatalog
      const controls = yield* FileTestControl
      const request = {
        fileSystemId: fileSystemA,
        actor,
        parentId: null,
        name: name("documents"),
        idempotencyKey: key("folder-replay"),
      }

      const first = yield* files.createFolder(request)
      const replay = yield* files.createFolder(request)
      expect(replay).toEqual(first)
      expect(yield* controls.liveNodes(fileSystemA)).toEqual([first])
      expect(
        (yield* controls.activities()).filter(
          (activity) => activity.action === "create_folder",
        ),
      ).toHaveLength(1)

      const conflict = yield* Effect.flip(
        files.createFolder({ ...request, name: name("other") }),
      )
      expect(conflict._tag).toBe("IdempotencyConflict")

      yield* files.softDelete({
        fileSystemId: fileSystemA,
        actor,
        fileId: first.id,
      })
      const unavailable = yield* Effect.flip(files.createFolder(request))
      expect(unavailable._tag).toBe("FolderNoLongerAvailable")
      if (unavailable._tag === "FolderNoLongerAvailable") {
        expect(unavailable.fileId).toBe(first.id)
      }

      expect(
        yield* reclamation.purgeReclaimedBatch({
          deletedBefore: TimestampMillisSchema.make(
            yield* Clock.currentTimeMillis,
          ),
          limit: MaintenanceBatchSizeSchema.make(100),
        }),
      ).toBe(1)
      expect(yield* controls.deletedNodes(fileSystemA)).toEqual([])

      const purgedUnavailable = yield* Effect.flip(
        files.createFolder(request),
      )
      expect(purgedUnavailable._tag).toBe("FolderNoLongerAvailable")
      if (purgedUnavailable._tag === "FolderNoLongerAvailable") {
        expect(purgedUnavailable.fileId).toBe(first.id)
      }
    }).pipe(Effect.provide(runtimeLayer(100))),
  )

  it.effect("replays pending uploads and rejects key reuse after confirmation", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const controls = yield* FileTestControl
      const request = {
        fileSystemId: fileSystemA,
        actor,
        parentId: null,
        name: name("empty.txt"),
        size: bytes(0),
        idempotencyKey: key("empty-upload"),
      }

      const first = yield* files.requestUpload(request)
      const replay = yield* files.requestUpload(request)
      expect(replay.fileId).toBe(first.fileId)
      expect(replay.url).not.toBe(first.url)

      const conflict = yield* Effect.flip(
        files.requestUpload({ ...request, name: name("different.txt") }),
      )
      expect(conflict._tag).toBe("IdempotencyConflict")

      const pending = yield* controls.liveNodes(fileSystemA)
      expect(pending).toHaveLength(1)
      yield* controls.putObject({
        fileSystemId: fileSystemA,
        fileId: first.fileId,
        size: bytes(0),
        contentType: null,
        digest: null,
      })
      const ready = yield* files.confirmUpload({
        fileSystemId: fileSystemA,
        actor,
        fileId: first.fileId,
      })
      expect(ready.size).toBe(0)
      const confirmedAgain = yield* files.confirmUpload({
        fileSystemId: fileSystemA,
        actor,
        fileId: first.fileId,
      })
      expect(confirmedAgain).toEqual(ready)

      const readyReplay = yield* Effect.flip(files.requestUpload(request))
      expect(readyReplay._tag).toBe("UploadAlreadyConfirmed")

      const capabilities = yield* controls.issuedCapabilities()
      expect(capabilities.map((capability) => capability._tag)).toEqual([
        "Upload",
        "Upload",
      ])
    }).pipe(Effect.provide(runtimeLayer(0))),
  )

  it.effect("keeps upload replay identity across rename and deletion", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const request = {
        fileSystemId: fileSystemA,
        actor,
        parentId: null,
        name: name("original.txt"),
        size: bytes(1),
        idempotencyKey: key("rename-replay"),
      }

      const first = yield* files.requestUpload(request)
      yield* files.move({
        fileSystemId: fileSystemA,
        actor,
        fileId: first.fileId,
        parentId: null,
        name: name("renamed.txt"),
      })

      const replay = yield* files.requestUpload(request)
      expect(replay.fileId).toBe(first.fileId)
      expect(replay.url).not.toBe(first.url)

      const changedFingerprint = yield* Effect.flip(
        files.requestUpload({ ...request, name: name("renamed.txt") }),
      )
      expect(changedFingerprint._tag).toBe("IdempotencyConflict")

      yield* files.softDelete({
        fileSystemId: fileSystemA,
        actor,
        fileId: first.fileId,
      })
      const unavailable = yield* Effect.flip(files.requestUpload(request))
      expect(unavailable._tag).toBe("UploadNoLongerAvailable")
      if (unavailable._tag === "UploadNoLongerAvailable") {
        expect(unavailable.fileId).toBe(first.fileId)
      }
    }).pipe(Effect.provide(runtimeLayer(100))),
  )

  it.effect("preserves typed quota-policy failure and pending visibility", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const controls = yield* FileTestControl
      const ticket = yield* files.requestUpload({
        fileSystemId: fileSystemA,
        actor,
        parentId: null,
        name: name("policy-failure.bin"),
        size: bytes(2),
        idempotencyKey: key("policy-failure"),
      })
      yield* controls.putObject({
        fileSystemId: fileSystemA,
        fileId: ticket.fileId,
        size: bytes(2),
        contentType: null,
        digest: null,
      })
      const before = yield* controls.liveNodes(fileSystemA)

      const failure = yield* Effect.flip(
        files.confirmUpload({
          fileSystemId: fileSystemA,
          actor,
          fileId: ticket.fileId,
        }),
      )

      expect(failure._tag).toBe("FileQuotaPolicyUnavailable")
      expect(yield* controls.liveNodes(fileSystemA)).toEqual(before)
      expect(before.map((node) => node._tag)).toEqual(["PendingFile"])
    }).pipe(Effect.provide(unavailableQuotaRuntimeLayer)),
  )

  it.effect("confirms quota atomically within one filesystem", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const controls = yield* FileTestControl
      const left = yield* files.requestUpload({
        fileSystemId: fileSystemA,
        actor,
        parentId: null,
        name: name("left.bin"),
        size: bytes(3),
        idempotencyKey: key("left-upload"),
      })
      const right = yield* files.requestUpload({
        fileSystemId: fileSystemA,
        actor,
        parentId: null,
        name: name("right.bin"),
        size: bytes(3),
        idempotencyKey: key("right-upload"),
      })
      yield* controls.putObject({
        fileSystemId: fileSystemA,
        fileId: left.fileId,
        size: bytes(3),
        contentType: null,
        digest: null,
      })
      yield* controls.putObject({
        fileSystemId: fileSystemA,
        fileId: right.fileId,
        size: bytes(3),
        contentType: null,
        digest: null,
      })

      const outcomes = yield* Effect.all(
        [
          files.confirmUpload({
            fileSystemId: fileSystemA,
            actor,
            fileId: left.fileId,
          }).pipe(
            Effect.match({
              onFailure: (error) => error._tag,
              onSuccess: () => "Ready",
            }),
          ),
          files.confirmUpload({
            fileSystemId: fileSystemA,
            actor,
            fileId: right.fileId,
          }).pipe(
            Effect.match({
              onFailure: (error) => error._tag,
              onSuccess: () => "Ready",
            }),
          ),
        ],
        { concurrency: "unbounded" },
      )
      expect([...outcomes].sort()).toEqual(["FileQuotaExceeded", "Ready"])

      const nodes = [
        ...(yield* controls.liveNodes(fileSystemA)),
      ]
      expect(nodes.filter((node) => node._tag === "ReadyFile")).toHaveLength(1)
      expect(nodes.filter((node) => node._tag === "PendingFile")).toHaveLength(1)
    }).pipe(Effect.provide(runtimeLayer(5))),
  )

  it.effect("renames only files and soft-deletes a folder subtree once", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const controls = yield* FileTestControl
      const parent = yield* files.createFolder({
        fileSystemId: fileSystemA,
        actor,
        parentId: null,
        name: name("parent"),
        idempotencyKey: key("folder-parent"),
      })
      const child = yield* files.createFolder({
        fileSystemId: fileSystemA,
        actor,
        parentId: parent.id,
        name: name("child"),
        idempotencyKey: key("folder-child"),
      })
      const first = yield* files.requestUpload({
        fileSystemId: fileSystemA,
        actor,
        parentId: child.id,
        name: name("first.txt"),
        size: bytes(1),
        idempotencyKey: key("first-upload"),
      })
      yield* files.requestUpload({
        fileSystemId: fileSystemA,
        actor,
        parentId: child.id,
        name: name("second.txt"),
        size: bytes(1),
        idempotencyKey: key("second-upload"),
      })

      const conflict = yield* Effect.flip(
        files.move({
          fileSystemId: fileSystemA,
          actor,
          fileId: first.fileId,
          parentId: child.id,
          name: name("second.txt"),
        }),
      )
      expect(conflict._tag).toBe("FileNameConflict")

      const renamed = yield* files.move({
        fileSystemId: fileSystemA,
        actor,
        fileId: first.fileId,
        parentId: child.id,
        name: name("renamed.txt"),
      })
      expect(renamed.path).toBe("parent/child/renamed.txt")

      yield* files.softDelete({
        fileSystemId: fileSystemA,
        actor,
        fileId: parent.id,
      })
      const root = yield* files.listChildren({
        fileSystemId: fileSystemA,
        actor,
        target: rootListTarget,
        page: fullPage,
      })
      expect(root.items).toEqual([])

      const repeatedDelete = yield* Effect.flip(
        files.softDelete({
          fileSystemId: fileSystemA,
          actor,
          fileId: parent.id,
        }),
      )
      expect(repeatedDelete._tag).toBe("FileNotFound")
      expect(yield* controls.liveNodes(fileSystemA)).toEqual([])
      expect(yield* controls.deletedNodes(fileSystemA)).toHaveLength(4)
    }).pipe(Effect.provide(runtimeLayer(100))),
  )

  it.effect("keeps activity best-effort and records issued download capabilities", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const controls = yield* FileTestControl

      yield* controls.failNextActivity()
      const folder = yield* files.createFolder({
        fileSystemId: fileSystemA,
        actor,
        parentId: null,
        name: name("downloads"),
        idempotencyKey: key("folder-downloads"),
      })
      expect(folder._tag).toBe("Folder")
      expect(yield* controls.activities()).toEqual([])

      const ticket = yield* files.requestUpload({
        fileSystemId: fileSystemA,
        actor,
        parentId: folder.id,
        name: name("ready.txt"),
        size: bytes(2),
        idempotencyKey: key("ready-upload"),
      })
      yield* controls.putObject({
        fileSystemId: fileSystemA,
        fileId: ticket.fileId,
        size: bytes(2),
        contentType: contentType("text/plain"),
        digest: null,
      })
      yield* files.confirmUpload({
        fileSystemId: fileSystemA,
        actor,
        fileId: ticket.fileId,
      })
      const download = yield* files.requestDownload({
        fileSystemId: fileSystemA,
        actor,
        fileId: ticket.fileId,
      })

      expect(download.file.name).toBe("ready.txt")
      expect((yield* controls.activities()).map((event) => event.action)).toEqual([
        "confirm_upload",
        "issue_download",
      ])
      expect(
        (yield* controls.issuedCapabilities()).map(
          (capability) => capability._tag,
        ),
      ).toEqual(["Upload", "Download"])
    }).pipe(Effect.provide(runtimeLayer(100))),
  )
})
