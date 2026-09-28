import { Clock, Context, Effect, Layer, Schema } from "effect"
import {
  FileActivitySink,
  FileCatalog,
  FileIds,
  FileObjects,
  toPublicFileNode,
  type FileActivityAction,
  type StoredFileNode,
  type StoredPendingFileNode,
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
  StaleFileNode,
  UploadAlreadyConfirmed,
  UploadChecksumMismatch,
  UploadNoLongerAvailable,
  UploadNotFound,
} from "./errors.js"
import {
  ByteCountSchema,
  TimestampMillisSchema,
  sha256Of,
  type ByteCount,
  type DownloadTicket,
  type FileActor,
  type FileChangePage,
  type FileChangeSequence,
  type FileContentType,
  type FileId,
  type FileListTarget,
  type FileName,
  type FileNode,
  type FilePage,
  type FileSystemId,
  type FolderNode,
  type IdempotencyKey,
  type PageCursor,
  type PageSize,
  type ReadyFileNode,
  type Sha256,
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

/** Read one live node. */
export interface GetNodeInput extends FileOperationContext {
  readonly fileId: FileId
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
  /** When set, the store rejects other bytes and confirmation requires this digest. */
  readonly sha256?: Sha256 | null
  /** When set, stored as the object's media type whatever the upload sends. */
  readonly contentType?: FileContentType | null
}

/** Confirm that bytes exist for a pending upload. */
export interface ConfirmUploadInput extends FileOperationContext {
  readonly fileId: FileId
}

/** Store bytes the host already holds as one ready file. */
export interface WriteFileInput extends FileOperationContext {
  readonly parentId: FileId | null
  readonly name: FileName
  readonly idempotencyKey: IdempotencyKey
  readonly body: Uint8Array<ArrayBuffer>
  readonly contentType: FileContentType | null
}

/** Issue a direct-download capability for one ready file. */
export interface RequestDownloadInput extends FileOperationContext {
  readonly fileId: FileId
}

/** Stream one ready file's bytes to the host. */
export interface ReadFileInput extends FileOperationContext {
  readonly fileId: FileId
}

/** One ready file and a stream of its bytes. */
export interface ReadFileResult {
  readonly file: ReadyFileNode
  readonly body: ReadableStream<Uint8Array>
}

/** Move a file or folder into another folder, rename it, or both. */
export interface MoveInput extends FileOperationContext {
  readonly fileId: FileId
  readonly parentId: FileId | null
  readonly name: FileName
  /** When set, the move applies only while the node was last changed at this instant. */
  readonly expectedUpdatedAt?: TimestampMillis | null
}

/** Soft-delete one file or folder subtree. */
export interface SoftDeleteInput extends FileOperationContext {
  readonly fileId: FileId
  /** When set, the delete applies only while the node was last changed at this instant. */
  readonly expectedUpdatedAt?: TimestampMillis | null
}

/** Read committed changes after a known position. */
export interface ListChangesInput extends FileOperationContext {
  readonly after: FileChangeSequence | null
  readonly limit: PageSize
}

/** Failures callers can handle while listing children. */
export type ListChildrenError =
  | FileNotFound
  | FolderRequired
  | InvalidFileInput
  | FileCatalogUnavailable
  | InvalidStoredFile

/** Failures callers can handle while reading one node. */
export type GetNodeError =
  | FileNotFound
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
  | UploadChecksumMismatch
  | FileTooLarge
  | FileQuotaExceeded
  | FileQuotaPolicyUnavailable
  | FileCatalogUnavailable
  | InvalidStoredFile
  | FileObjectStoreUnavailable

/** Failures callers can handle while writing a file from the host. */
export type WriteFileError =
  | FileNotFound
  | FolderRequired
  | FileNameConflict
  | IdempotencyConflict
  | UploadNoLongerAvailable
  | UploadNotFound
  | UploadChecksumMismatch
  | FileTooLarge
  | FileQuotaExceeded
  | FileQuotaPolicyUnavailable
  | InvalidFileInput
  | FileCatalogUnavailable
  | InvalidStoredFile
  | FileObjectStoreUnavailable

/** Failures callers can handle while requesting a download. */
export type RequestDownloadError =
  | FileNotFound
  | FileRequired
  | UploadNotFound
  | FileCatalogUnavailable
  | InvalidStoredFile
  | FileCapabilityUnavailable

/** Failures callers can handle while reading a file's bytes. */
export type ReadFileError =
  | FileNotFound
  | FileRequired
  | UploadNotFound
  | FileCatalogUnavailable
  | InvalidStoredFile
  | FileObjectStoreUnavailable

/** Failures callers can handle while moving a node. */
export type MoveError =
  | FileNotFound
  | FolderRequired
  | FileNameConflict
  | StaleFileNode
  | InvalidFileInput
  | FileCatalogUnavailable
  | InvalidStoredFile

/** Failures callers can handle while deleting a subtree. */
export type SoftDeleteError =
  | FileNotFound
  | StaleFileNode
  | FileCatalogUnavailable
  | InvalidStoredFile

/** Failures callers can handle while reading the change log. */
export type ListChangesError = FileCatalogUnavailable | InvalidStoredFile

/** Cohesive filesystem use cases over catalog and byte-object seams. */
export interface FileSystemService {
  readonly listChildren: (
    input: ListChildrenInput,
  ) => Effect.Effect<FilePage, ListChildrenError>
  readonly getNode: (
    input: GetNodeInput,
  ) => Effect.Effect<FileNode, GetNodeError>
  readonly createFolder: (
    input: CreateFolderInput,
  ) => Effect.Effect<FolderNode, CreateFolderError>
  readonly requestUpload: (
    input: RequestUploadInput,
  ) => Effect.Effect<UploadTicket, RequestUploadError>
  readonly confirmUpload: (
    input: ConfirmUploadInput,
  ) => Effect.Effect<ReadyFileNode, ConfirmUploadError>
  /** Reserve, store and confirm in one idempotent command; a replay returns the file. */
  readonly writeFile: (
    input: WriteFileInput,
  ) => Effect.Effect<ReadyFileNode, WriteFileError>
  readonly requestDownload: (
    input: RequestDownloadInput,
  ) => Effect.Effect<DownloadTicket, RequestDownloadError>
  readonly readFile: (
    input: ReadFileInput,
  ) => Effect.Effect<ReadFileResult, ReadFileError>
  readonly move: (input: MoveInput) => Effect.Effect<FileNode, MoveError>
  readonly softDelete: (
    input: SoftDeleteInput,
  ) => Effect.Effect<void, SoftDeleteError>
  readonly listChanges: (
    input: ListChangesInput,
  ) => Effect.Effect<FileChangePage, ListChangesError>
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

const asReadyNode = (node: StoredReadyFileNode): ReadyFileNode =>
  toPublicFileNode(node)

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

  const liveReadyFile = Effect.fn("FileSystem.liveReadyFile")(function* (
    fileSystemId: FileSystemId,
    fileId: FileId,
  ) {
    const node = yield* catalog.get(fileSystemId, fileId)
    if (node === null) {
      return yield* Effect.fail(new FileNotFound({ fileId }))
    }
    if (node._tag === "Folder") {
      return yield* Effect.fail(new FileRequired({ fileId }))
    }
    if (node._tag === "PendingFile") {
      return yield* Effect.fail(new UploadNotFound({ fileId }))
    }
    return node
  })

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

  const getNode = Effect.fn("FileSystem.getNode")(function* (
    input: GetNodeInput,
  ) {
    const node = yield* catalog.get(input.fileSystemId, input.fileId)
    if (node === null) {
      return yield* Effect.fail(new FileNotFound({ fileId: input.fileId }))
    }
    return toPublicFileNode(node)
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

  type ReservationOutcome =
    | { readonly _tag: "Pending"; readonly node: StoredPendingFileNode }
    | { readonly _tag: "Ready"; readonly node: StoredReadyFileNode }

  const reserve = Effect.fn("FileSystem.reserve")(function* (
    input: FileOperationContext & {
      readonly parentId: FileId | null
      readonly name: FileName
      readonly idempotencyKey: IdempotencyKey
      readonly size: ByteCount
      readonly sha256: Sha256 | null
    },
    at: TimestampMillis,
  ) {
    const id = yield* ids.nextFileId
    const result = yield* catalog.reserveUpload({
      id,
      parentId: input.parentId,
      name: input.name,
      idempotencyKey: input.idempotencyKey,
      locator: objects.locationFor(input.fileSystemId, id),
      maximumBytes: input.size,
      pendingExpiresAt: futureTimestamp(at, objects.reclamationGraceMillis),
      expectedSha256: input.sha256,
      fileSystemId: input.fileSystemId,
      actor: input.actor,
      now: at,
    })
    switch (result._tag) {
      case "Created":
      case "ReplayPending": {
        const outcome: ReservationOutcome = {
          _tag: "Pending",
          node: result.node,
        }
        return outcome
      }
      case "ReplayReady": {
        const outcome: ReservationOutcome = {
          _tag: "Ready",
          node: result.node,
        }
        return outcome
      }
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

  const requestUpload = Effect.fn("FileSystem.requestUpload")(function* (
    input: RequestUploadInput,
  ) {
    if (input.size > settings.maximumUploadBytes) {
      return yield* Effect.fail(new FileTooLarge())
    }

    const at = yield* nowMillis
    const reservation = yield* reserve(
      { ...input, sha256: input.sha256 ?? null },
      at,
    )
    if (reservation._tag === "Ready") {
      return yield* Effect.fail(
        new UploadAlreadyConfirmed({ fileId: reservation.node.id }),
      )
    }
    const capability = yield* objects.issueUpload({
      locator: reservation.node.locator,
      maximumBytes: reservation.node.maximumBytes,
      expiresAt: futureTimestamp(at, objects.uploadCapabilityTtlMillis),
      sha256: reservation.node.expectedSha256,
      contentType: input.contentType ?? null,
    })
    return {
      fileId: reservation.node.id,
      url: capability.url,
      expiresAt: capability.expiresAt,
    }
  })

  const confirmPending = Effect.fn("FileSystem.confirmPending")(function* (
    context: FileOperationContext,
    current: StoredPendingFileNode,
  ) {
    const metadata = yield* objects.stat(current.locator)
    if (metadata === null) {
      return yield* Effect.fail(new UploadNotFound({ fileId: current.id }))
    }
    if (
      metadata.size > current.maximumBytes ||
      metadata.size > settings.maximumUploadBytes
    ) {
      return yield* Effect.fail(new FileTooLarge())
    }
    if (
      current.expectedSha256 !== null &&
      (metadata.digest?._tag !== "Sha256" ||
        metadata.digest.value !== current.expectedSha256)
    ) {
      return yield* Effect.fail(
        new UploadChecksumMismatch({ fileId: current.id }),
      )
    }

    const at = yield* nowMillis
    const quotaBytes = yield* quotaPolicy.quotaBytesFor(context.fileSystemId)
    const result = yield* catalog.confirmUpload({
      fileId: current.id,
      size: metadata.size,
      contentType: metadata.contentType,
      digest: metadata.digest,
      quotaBytes,
      fileSystemId: context.fileSystemId,
      actor: context.actor,
      now: at,
    })
    switch (result._tag) {
      case "Confirmed":
        yield* recordActivityBestEffort(
          "confirm_upload",
          context,
          current.id,
          at,
        )
        return asReadyNode(result.node)
      case "AlreadyReady":
        return asReadyNode(result.node)
      case "NotFound":
        return yield* Effect.fail(new FileNotFound({ fileId: current.id }))
      case "QuotaExceeded":
        return yield* Effect.fail(new FileQuotaExceeded())
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
    return yield* confirmPending(input, current)
  })

  const writeFile = Effect.fn("FileSystem.writeFile")(function* (
    input: WriteFileInput,
  ) {
    if (input.body.byteLength > settings.maximumUploadBytes) {
      return yield* Effect.fail(new FileTooLarge())
    }
    const sha256 = yield* sha256Of(input.body)
    const at = yield* nowMillis
    const reservation = yield* reserve(
      {
        ...input,
        size: ByteCountSchema.make(input.body.byteLength),
        sha256,
      },
      at,
    )
    if (reservation._tag === "Ready") {
      return asReadyNode(reservation.node)
    }
    yield* objects.put({
      locator: reservation.node.locator,
      body: input.body,
      contentType: input.contentType,
      sha256,
    })
    const ready = yield* confirmPending(input, reservation.node)
    yield* recordActivityBestEffort("write_file", input, ready.id, at)
    return ready
  })

  const requestDownload = Effect.fn("FileSystem.requestDownload")(function* (
    input: RequestDownloadInput,
  ) {
    const node = yield* liveReadyFile(input.fileSystemId, input.fileId)
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
      file: asReadyNode(stillLive),
      url: capability.url,
      expiresAt: capability.expiresAt,
    }
  })

  const readFile = Effect.fn("FileSystem.readFile")(function* (
    input: ReadFileInput,
  ) {
    const node = yield* liveReadyFile(input.fileSystemId, input.fileId)
    const body = yield* objects.get(node.locator)
    if (body === null) {
      return yield* Effect.fail(
        new FileObjectStoreUnavailable({
          operation: "get",
          cause: new Error("A ready file has no stored object."),
        }),
      )
    }
    const at = yield* nowMillis
    yield* recordActivityBestEffort("read_file", input, input.fileId, at)
    return { file: asReadyNode(node), body }
  })

  const move = Effect.fn("FileSystem.move")(function* (input: MoveInput) {
    const at = yield* nowMillis
    const result = yield* catalog.move({
      fileId: input.fileId,
      parentId: input.parentId,
      name: input.name,
      expectedUpdatedAt: input.expectedUpdatedAt ?? null,
      fileSystemId: input.fileSystemId,
      actor: input.actor,
      now: at,
    })
    switch (result._tag) {
      case "Moved":
        yield* recordActivityBestEffort("move_node", input, input.fileId, at)
        return toPublicFileNode(result.node)
      case "Unchanged":
        return toPublicFileNode(result.node)
      case "NotFound":
        return yield* Effect.fail(new FileNotFound({ fileId: input.fileId }))
      case "Stale":
        return yield* Effect.fail(new StaleFileNode({ fileId: input.fileId }))
      case "ParentNotFound":
        return yield* Effect.fail(new FileNotFound({ fileId: input.parentId }))
      case "ParentNotFolder":
        return yield* Effect.fail(
          new FolderRequired({ fileId: result.parentId }),
        )
      case "Cycle":
        return yield* Effect.fail(
          new InvalidFileInput({ reason: "move_into_itself" }),
        )
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
      expectedUpdatedAt: input.expectedUpdatedAt ?? null,
    })
    switch (result._tag) {
      case "Deleted":
        yield* recordActivityBestEffort("soft_delete", input, input.fileId, at)
        return
      case "NotFound":
        return yield* Effect.fail(new FileNotFound({ fileId: input.fileId }))
      case "Stale":
        return yield* Effect.fail(new StaleFileNode({ fileId: input.fileId }))
    }
  })

  const listChanges = Effect.fn("FileSystem.listChanges")(function* (
    input: ListChangesInput,
  ) {
    return yield* catalog.listChanges(
      input.fileSystemId,
      input.after,
      input.limit,
    )
  })

  return FileSystem.of({
    listChildren,
    getNode,
    createFolder,
    requestUpload,
    confirmUpload,
    writeFile,
    requestDownload,
    readFile,
    move,
    softDelete,
    listChanges,
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
export const projectNode = (node: StoredFileNode): FileNode =>
  toPublicFileNode(node)
