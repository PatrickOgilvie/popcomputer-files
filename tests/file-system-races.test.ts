import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  FileCatalog,
  FileIds,
  FileObjectLocatorSchema,
  FileObjects,
  StoredFileNodeSchema,
  discardFileActivityLayer,
} from "../src/adapter.js"
import {
  FileSystem,
  fixedQuotaPolicyLayer,
  layer as fileSystemLayer,
} from "../src/file-system.js"
import {
  ByteCountSchema,
  CapabilityUrlSchema,
  FileActorIdSchema,
  FileActorKindSchema,
  FileActorSchema,
  FileIdSchema,
  FileNameSchema,
  FileSystemIdSchema,
  RelativePathSchema,
  TimestampMillisSchema,
} from "../src/file.js"

const unexpected = (operation: string): Effect.Effect<never> =>
  Effect.die(new Error(`unexpected ${operation}`))

describe("FileSystem concurrency", () => {
  it.effect("suppresses a download capability when deletion wins during issuance", () => {
    const fileSystemId = FileSystemIdSchema.make("download-race")
    const fileId = FileIdSchema.make("file-download-race")
    const locator = FileObjectLocatorSchema.make("object:download-race")
    const timestamp = TimestampMillisSchema.make(1_000)
    const size = ByteCountSchema.make(1)
    const node = StoredFileNodeSchema.cases.ReadyFile.make({
      id: fileId,
      parentId: null,
      name: FileNameSchema.make("report.txt"),
      path: RelativePathSchema.make("report.txt"),
      createdAt: timestamp,
      updatedAt: timestamp,
      locator,
      maximumBytes: size,
      size,
      contentType: null,
      digest: null,
    })
    let reads = 0
    let issued = 0

    const catalog = FileCatalog.of({
      get: () =>
        Effect.sync(() => {
          reads += 1
          return reads === 1 ? node : null
        }),
      listChildren: () => unexpected("listChildren"),
      createFolder: () => unexpected("createFolder"),
      reserveUpload: () => unexpected("reserveUpload"),
      confirmUpload: () => unexpected("confirmUpload"),
      renameFile: () => unexpected("renameFile"),
      softDelete: () => unexpected("softDelete"),
    })
    const objects = FileObjects.of({
      uploadCapabilityTtlMillis: 60_000,
      reclamationGraceMillis: 60_000,
      locationFor: () => locator,
      stat: () => unexpected("stat"),
      issueUpload: () => unexpected("issueUpload"),
      issueDownload: () =>
        Effect.sync(() => {
          issued += 1
          return {
            url: CapabilityUrlSchema.make(
              "https://files.example.com/o/download-race",
            ),
            expiresAt: TimestampMillisSchema.make(61_000),
          }
        }),
      delete: () => unexpected("delete"),
    })
    const dependencies = Layer.mergeAll(
      Layer.succeed(FileCatalog, catalog),
      Layer.succeed(FileObjects, objects),
      Layer.succeed(
        FileIds,
        FileIds.of({
          nextFileId: unexpected("nextFileId"),
          nextActivityId: unexpected("nextActivityId"),
        }),
      ),
      discardFileActivityLayer,
      fixedQuotaPolicyLayer(ByteCountSchema.make(100)),
    )
    const runtime = fileSystemLayer({
      maximumUploadBytes: ByteCountSchema.make(100),
    }).pipe(Layer.provide(dependencies))

    return Effect.gen(function* () {
      const files = yield* FileSystem
      const failure = yield* Effect.flip(
        files.requestDownload({
          fileSystemId,
          actor: FileActorSchema.make({
            kind: FileActorKindSchema.make("user"),
            id: FileActorIdSchema.make("user-1"),
          }),
          fileId,
        }),
      )

      expect(failure._tag).toBe("FileNotFound")
      expect(reads).toBe(2)
      expect(issued).toBe(1)
    }).pipe(Effect.provide(runtime))
  })
})
