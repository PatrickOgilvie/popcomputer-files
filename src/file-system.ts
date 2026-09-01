import { Clock, Context, Effect, Layer, Schema } from "effect"
import {
  FileActivitySink,
  FileCatalog,
  FileIds,
  FileObjects,
  toPublicFileNode,
  type FileActivityAction,
  type StoredFileNode,
  type StoredReadyFileNode,
} from "./adapter.js"
import {
  FileCapabilityUnavailable,
  FileCatalogUnavailable,
  FolderNoLongerAvailable,
  FileNameConflict,
  FileNotFound,
  FileObjectStoreUnavailable,
  FileQuotaExceeded,
  FileQuotaPolicyUnavailable,
  FileRequired,
  FileTooLarge,
  FolderRequired,
  IdempotencyConflict,
  InvalidFileInput,
  InvalidStoredFile,
  UploadAlreadyConfirmed,
  UploadNoLongerAvailable,
  UploadNotFound,
} from "./errors.js"
import {
  ByteCountSchema,
  TimestampMillisSchema,
  type ByteCount,
  type DownloadTicket,
  type FileActor,
  type FileId,
  type FileListTarget,
  type FileName,
  type FilePage,
  type FileSystemId,
  type FolderNode,
  type IdempotencyKey,
  type PageCursor,
  type PageSize,
  type PendingFileNode,
  type ReadyFileNode,
  type TimestampMillis,
  type UploadTicket,
} from "./file.js"

/** Parsed upload limit owned by the host application. */
export const FileSystemSettingsSchema = Schema.Struct({
  maximumUploadBytes: ByteCountSchema,
})
/** Parsed upload limit owned by the host application. */
export interface FileSystemSettings
  extends Schema.Schema.Type<typeof FileSystemSettingsSchema> {}

/** Common authenticated context for one filesystem operation. */
export interface FileOperationContext {
  readonly fileSystemId: FileSystemId
  readonly actor: FileActor
}

/** List one folder's direct children. */
export interface ListChildrenInput extends FileOperationContext {
  readonly target: FileListTarget
  readonly page: {
    readonly size: PageSize
    readonly cursor: PageCursor | null
  }
}

/** Create one folder at the root or beneath an existing folder. */
export interface CreateFolderInput extends FileOperationContext {
  readonly parentId: FileId | null
  readonly name: FileName
  readonly idempotencyKey: IdempotencyKey
}

/** Reserve metadata and issue a direct-upload capability. */
export interface RequestUploadInput extends FileOperationContext {
  readonly parentId: FileId | null
  readonly name: FileName
  readonly size: ByteCount
  readonly idempotencyKey: IdempotencyKey
}

/** Confirm that bytes exist for a pending upload. */
export interface ConfirmUploadInput extends FileOperationContext {
  readonly fileId: FileId
}

/** Issue a direct-download capability for one ready file. */
export interface RequestDownloadInput extends FileOperationContext {
  readonly fileId: FileId
}

/** Rename one pending or ready file leaf. */
export interface RenameFileInput extends FileOperationContext {
  readonly fileId: FileId
  readonly name: FileName
}

/** Soft-delete one file or folder subtree. */
export interface SoftDeleteInput extends FileOperationContext {
  readonly fileId: FileId
}

/** Failures callers can handle while listing children. */
export type ListChildrenError =
  | FileNotFound
  | FolderRequired
  | InvalidFileInput
  | FileCatalogUnavailable
  | InvalidStoredFile

/** Failures callers can handle while creating a folder. */
export type CreateFolderError =
  | FileNotFound
  | FolderRequired
  | FileNameConflict
  | IdempotencyConflict
  | FolderNoLongerAvailable
  | InvalidFileInput
  | FileCatalogUnavailable
  | InvalidStoredFile

/** Failures callers can handle while reserving an upload. */
export type RequestUploadError =
  | FileNotFound
  | FolderRequired
  | FileNameConflict
  | IdempotencyConflict
  | UploadAlreadyConfirmed
  | UploadNoLongerAvailable
  | FileTooLarge
  | InvalidFileInput
  | FileCatalogUnavailable
  | InvalidStoredFile
  | FileCapabilityUnavailable

/** Failures callers can handle while confirming an upload. */
export type ConfirmUploadError =
  | FileNotFound
  | UploadNotFound
  | FileTooLarge
  | FileQuotaExceeded
  | FileQuotaPolicyUnavailable
  | FileCatalogUnavailable
  | InvalidStoredFile
  | FileObjectStoreUnavailable

/** Failures callers can handle while requesting a download. */
export type RequestDownloadError =
  | FileNotFound
  | UploadNotFound
  | FileCatalogUnavailable
  | InvalidStoredFile
  | FileCapabilityUnavailable

/** Failures callers can handle while renaming a file. */
export type RenameFileError =
  | FileNotFound
  | FileRequired
  | FileNameConflict
  | InvalidFileInput
  | FileCatalogUnavailable
  | InvalidStoredFile

/** Failures callers can handle while deleting a subtree. */
export type SoftDeleteError =
  | FileNotFound
  | FileCatalogUnavailable
  | InvalidStoredFile

/** Cohesive filesystem use cases over catalog and byte-object seams. */
export interface FileSystemService {
  readonly listChildren: (
    input: ListChildrenInput,
  ) => Effect.Effect<FilePage, ListChildrenError>
  readonly createFolder: (
    input: CreateFolderInput,
  ) => Effect.Effect<FolderNode, CreateFolderError>
  readonly requestUpload: (
    input: RequestUploadInput,
  ) => Effect.Effect<UploadTicket, RequestUploadError>
  readonly confirmUpload: (
    input: ConfirmUploadInput,
  ) => Effect.Effect<ReadyFileNode, ConfirmUploadError>
  readonly requestDownload: (
    input: RequestDownloadInput,
  ) => Effect.Effect<DownloadTicket, RequestDownloadError>
  readonly renameFile: (
    input: RenameFileInput,
  ) => Effect.Effect<PendingFileNode | ReadyFileNode, RenameFileError>
  readonly softDelete: (
    input: SoftDeleteInput,
  ) => Effect.Effect<void, SoftDeleteError>
}

/** Effect service tag for the filesystem use cases. */
export class FileSystem extends Context.Service<
  FileSystem,
  FileSystemService
>()("@popcomputer/files/FileSystem") {}

const nowMillis = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => TimestampMillisSchema.make(millis)),
)

const futureTimestamp = (
  now: TimestampMillis,
  durationMillis: number,
): TimestampMillis => TimestampMillisSchema.make(now + durationMillis)

const asReadyNode = (node: StoredReadyFileNode): ReadyFileNode => {
  return {
    _tag: "ReadyFile",
    id: node.id,
    parentId: node.parentId,
    name: node.name,
    path: node.path,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    size: node.size,
    contentType: node.contentType,
    digest: node.digest,
  }
}

const makeService = Effect.gen(function* () {
  const catalog = yield* FileCatalog
  const objects = yield* FileObjects
  const activities = yield* FileActivitySink
  const ids = yield* FileIds
  const settings = yield* FileSystemConfiguration
  const quotaPolicy = yield* FileQuotaPolicy

  const recordActivity = Effect.fn("FileSystem.recordActivity")(function* (
    action: FileActivityAction,
    context: FileOperationContext,
    fileId: FileId,
    at: TimestampMillis,
  ) {
    const id = yield* ids.nextActivityId
    yield* activities.record({
      id,
      action,
      fileSystemId: context.fileSystemId,
      actor: context.actor,
      fileId,
      at,
    })
  })

  const recordActivityBestEffort = (
    action: FileActivityAction,
    context: FileOperationContext,
    fileId: FileId,
    at: TimestampMillis,
  ): Effect.Effect<void> =>
    recordActivity(action, context, fileId, at).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("file activity record failed", {
          operation: action,
          errorTag: error._tag,
        }),
      ),
      Effect.catch(() => Effect.void),
    )

  const listChildren = Effect.fn("FileSystem.listChildren")(function* (
    input: ListChildrenInput,
  ) {
    const result = yield* catalog.listChildren(
      input.fileSystemId,
      input.target,
      input.page,
    )
    switch (result._tag) {
      case "Page":
        return {
          items: result.page.items.map(toPublicFileNode),
          cursor: result.page.cursor,
        }
      case "TargetNotFound":
        return yield* Effect.fail(new FileNotFound({ fileId: null }))
      case "TargetNotFolder":
        return yield* Effect.fail(
          new FolderRequired({ fileId: result.fileId }),
        )
      case "InvalidCursor":
        return yield* Effect.fail(
          new InvalidFileInput({ reason: "invalid_cursor" }),
        )
    }
  })

  const createFolder = Effect.fn("FileSystem.createFolder")(function* (
    input: CreateFolderInput,
  ) {
    const at = yield* nowMillis
    const id = yield* ids.nextFileId
    const result = yield* catalog.createFolder({
      id,
      parentId: input.parentId,
      name: input.name,
      idempotencyKey: input.idempotencyKey,
      fileSystemId: input.fileSystemId,
      actor: input.actor,
      now: at,
    })
    switch (result._tag) {
      case "Created":
        yield* recordActivityBestEffort(
          "create_folder",
          input,
          result.node.id,
          at,
        )
        return toPublicFileNode(result.node)
      case "ReplayFolder":
        return toPublicFileNode(result.node)
      case "ReplayUnavailable":
        return yield* Effect.fail(
          new FolderNoLongerAvailable({ fileId: result.fileId }),
        )
      case "ParentNotFound":
        return yield* Effect.fail(new FileNotFound({ fileId: input.parentId }))
      case "ParentNotFolder":
        return yield* Effect.fail(
          new FolderRequired({ fileId: result.parentId }),
        )
      case "NameConflict":
        return yield* Effect.fail(new FileNameConflict())
      case "IdempotencyConflict":
        return yield* Effect.fail(new IdempotencyConflict())
      case "InvalidPath":
        return yield* Effect.fail(
          new InvalidFileInput({ reason: "invalid_path" }),
        )
    }
  })

  const requestUpload = Effect.fn("FileSystem.requestUpload")(function* (
    input: RequestUploadInput,
  ) {
    if (input.size > settings.maximumUploadBytes) {
      return yield* Effect.fail(new FileTooLarge())
    }

    const at = yield* nowMillis
    const id = yield* ids.nextFileId
    const uploadExpiresAt = futureTimestamp(
      at,
      objects.uploadCapabilityTtlMillis,
    )
    const pendingExpiresAt = futureTimestamp(
      at,
      objects.reclamationGraceMillis,
    )
    const locator = objects.locationFor(input.fileSystemId, id)
    const result = yield* catalog.reserveUpload({
      id,
      parentId: input.parentId,
      name: input.name,
      idempotencyKey: input.idempotencyKey,
      locator,
      maximumBytes: input.size,
      pendingExpiresAt,
      fileSystemId: input.fileSystemId,
      actor: input.actor,
      now: at,
    })

    switch (result._tag) {
      case "Created":
      case "ReplayPending": {
        const capability = yield* objects.issueUpload({
          locator: result.node.locator,
          maximumBytes: result.node.maximumBytes,
          expiresAt: uploadExpiresAt,
        })
        return {
          fileId: result.node.id,
          url: capability.url,
          expiresAt: capability.expiresAt,
        }
      }
      case "ReplayReady":
        return yield* Effect.fail(
          new UploadAlreadyConfirmed({ fileId: result.node.id }),
        )
      case "ReplayUnavailable":
        return yield* Effect.fail(
          new UploadNoLongerAvailable({ fileId: result.fileId }),
        )
      case "ParentNotFound":
        return yield* Effect.fail(new FileNotFound({ fileId: input.parentId }))
      case "ParentNotFolder":
        return yield* Effect.fail(
          new FolderRequired({ fileId: result.parentId }),
        )
      case "NameConflict":
        return yield* Effect.fail(new FileNameConflict())
      case "IdempotencyConflict":
        return yield* Effect.fail(new IdempotencyConflict())
      case "InvalidPath":
        return yield* Effect.fail(
          new InvalidFileInput({ reason: "invalid_path" }),
        )
    }
  })

  const confirmUpload = Effect.fn("FileSystem.confirmUpload")(function* (
    input: ConfirmUploadInput,
  ) {
    const current = yield* catalog.get(input.fileSystemId, input.fileId)
    if (current === null || current._tag === "Folder") {
      return yield* Effect.fail(new FileNotFound({ fileId: input.fileId }))
    }
    if (current._tag === "ReadyFile") {
      return asReadyNode(current)
    }

    const metadata = yield* objects.stat(current.locator)
    if (metadata === null) {
      return yield* Effect.fail(new UploadNotFound({ fileId: input.fileId }))
    }
    if (
      metadata.size > current.maximumBytes ||
      metadata.size > settings.maximumUploadBytes
    ) {
      return yield* Effect.fail(new FileTooLarge())
    }

    const at = yield* nowMillis
    const quotaBytes = yield* quotaPolicy.quotaBytesFor(
      input.fileSystemId,
    )
    const result = yield* catalog.confirmUpload({
      fileId: input.fileId,
      size: metadata.size,
      contentType: metadata.contentType,
      digest: metadata.digest,
      quotaBytes,
      fileSystemId: input.fileSystemId,
      actor: input.actor,
      now: at,
    })
    switch (result._tag) {
      case "Confirmed":
        yield* recordActivityBestEffort(
          "confirm_upload",
          input,
          input.fileId,
          at,
        )
        return asReadyNode(result.node)
      case "AlreadyReady":
        return asReadyNode(result.node)
      case "NotFound":
        return yield* Effect.fail(new FileNotFound({ fileId: input.fileId }))
      case "QuotaExceeded":
        return yield* Effect.fail(new FileQuotaExceeded())
    }
  })

  const requestDownload = Effect.fn("FileSystem.requestDownload")(function* (
    input: RequestDownloadInput,
  ) {
    const node = yield* catalog.get(input.fileSystemId, input.fileId)
    if (node === null || node._tag === "Folder") {
      return yield* Effect.fail(new FileNotFound({ fileId: input.fileId }))
    }
    if (node._tag === "PendingFile") {
      return yield* Effect.fail(new UploadNotFound({ fileId: input.fileId }))
    }

    const capability = yield* objects.issueDownload({
      locator: node.locator,
      fileName: node.name,
    })
    const stillLive = yield* catalog.get(input.fileSystemId, input.fileId)
    if (
      stillLive === null ||
      stillLive._tag !== "ReadyFile" ||
      stillLive.locator !== node.locator
    ) {
      return yield* Effect.fail(new FileNotFound({ fileId: input.fileId }))
    }
    const at = yield* nowMillis
    yield* recordActivityBestEffort(
      "issue_download",
      input,
      input.fileId,
      at,
    )
    return {
      file: asReadyNode(node),
      url: capability.url,
      expiresAt: capability.expiresAt,
    }
  })

  const renameFile = Effect.fn("FileSystem.renameFile")(function* (
    input: RenameFileInput,
  ) {
    const at = yield* nowMillis
    const result = yield* catalog.renameFile({
      fileId: input.fileId,
      name: input.name,
      fileSystemId: input.fileSystemId,
      actor: input.actor,
      now: at,
    })
    switch (result._tag) {
      case "Renamed":
        yield* recordActivityBestEffort(
          "rename_file",
          input,
          input.fileId,
          at,
        )
        return toPublicFileNode(result.node)
      case "NotFound":
        return yield* Effect.fail(new FileNotFound({ fileId: input.fileId }))
      case "FolderNotSupported":
        return yield* Effect.fail(new FileRequired({ fileId: input.fileId }))
      case "NameConflict":
        return yield* Effect.fail(new FileNameConflict())
      case "InvalidPath":
        return yield* Effect.fail(
          new InvalidFileInput({ reason: "invalid_path" }),
        )
    }
  })

  const softDelete = Effect.fn("FileSystem.softDelete")(function* (
    input: SoftDeleteInput,
  ) {
    const at = yield* nowMillis
    const reclaimAfter = futureTimestamp(
      at,
      objects.reclamationGraceMillis,
    )
    const result = yield* catalog.softDelete({
      fileId: input.fileId,
      fileSystemId: input.fileSystemId,
      actor: input.actor,
      now: at,
      reclaimAfter,
    })
    if (result._tag === "NotFound") {
      return yield* Effect.fail(new FileNotFound({ fileId: input.fileId }))
    }
    yield* recordActivityBestEffort("soft_delete", input, input.fileId, at)
  })

  return FileSystem.of({
    listChildren,
    createFolder,
    requestUpload,
    confirmUpload,
    requestDownload,
    renameFile,
    softDelete,
  })
})

/** Internal Effect service tag for validated filesystem policy. */
class FileSystemConfiguration extends Context.Service<
  FileSystemConfiguration,
  FileSystemSettings
>()("@popcomputer/files/FileSystemConfiguration") {}

/** Host-owned resolver for the current quota of one logical filesystem. */
export interface FileQuotaPolicyService {
  readonly quotaBytesFor: (
    fileSystemId: FileSystemId,
  ) => Effect.Effect<ByteCount, FileQuotaPolicyUnavailable>
}

/** Effect service tag for host-owned per-filesystem quota policy. */
export class FileQuotaPolicy extends Context.Service<
  FileQuotaPolicy,
  FileQuotaPolicyService
>()("@popcomputer/files/FileQuotaPolicy") {}

/** Provide a host-owned dynamic quota resolver. */
export const quotaPolicyLayer = (
  service: FileQuotaPolicyService,
): Layer.Layer<FileQuotaPolicy> =>
  Layer.succeed(FileQuotaPolicy, FileQuotaPolicy.of(service))

/** Provide one fixed quota to every filesystem in a simple deployment. */
export const fixedQuotaPolicyLayer = (
  quotaBytes: ByteCount,
): Layer.Layer<FileQuotaPolicy> =>
  quotaPolicyLayer({ quotaBytesFor: () => Effect.succeed(quotaBytes) })

/** Construct the filesystem layer from validated policy and adapter services. */
export const layer = (
  settings: FileSystemSettings,
): Layer.Layer<
  FileSystem,
  never,
  | FileCatalog
  | FileObjects
  | FileActivitySink
  | FileIds
  | FileQuotaPolicy
> =>
  Layer.effect(FileSystem, makeService).pipe(
    Layer.provide(
      Layer.succeed(FileSystemConfiguration, settings),
    ),
  )

/** Construct a parsed byte count for programmatic configuration and tests. */
export const byteCount = (value: number): ByteCount =>
  ByteCountSchema.make(value)

/** Project a catalog record through the public file-node contract. */
export const projectNode = (node: StoredFileNode) => toPublicFileNode(node)
