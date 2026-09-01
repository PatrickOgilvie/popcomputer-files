import { Context, Effect, Layer, Schema } from "effect"
import type {
  ByteCount,
  CapabilityUrl,
  ContentDigest,
  FileActor,
  FileContentType,
  FileId,
  FileListTarget,
  FileName,
  FileNode,
  FileSystemId,
  FolderNode,
  IdempotencyKey,
  MaintenanceBatchSize,
  PageCursor,
  PageSize,
  PendingFileNode,
  ReadyFileNode,
  TimestampMillis,
} from "./file.js"
import {
  ByteCountSchema,
  ContentDigestSchema,
  FileContentTypeSchema,
  FileIdSchema,
  FileNameSchema,
  RelativePathSchema,
  TimestampMillisSchema,
} from "./file.js"
import type {
  FileActivityUnavailable,
  FileCapabilityUnavailable,
  FileCatalogUnavailable,
  FileObjectStoreUnavailable,
  InvalidStoredFile,
} from "./errors.js"

/** Opaque, adapter-owned location of one byte object. */
export const FileObjectLocatorSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1024),
).pipe(Schema.brand("@popcomputer/files/FileObjectLocator"))
/** Opaque, adapter-owned location of one byte object. */
export type FileObjectLocator = Schema.Schema.Type<
  typeof FileObjectLocatorSchema
>

const storedNodeBase = {
  id: FileIdSchema,
  parentId: Schema.NullOr(FileIdSchema),
  name: FileNameSchema,
  path: RelativePathSchema,
  createdAt: TimestampMillisSchema,
  updatedAt: TimestampMillisSchema,
}

/** Correct-by-construction live catalog record. */
export const StoredFileNodeSchema = Schema.TaggedUnion({
  Folder: storedNodeBase,
  PendingFile: {
    ...storedNodeBase,
    locator: FileObjectLocatorSchema,
    maximumBytes: ByteCountSchema,
    pendingExpiresAt: TimestampMillisSchema,
  },
  ReadyFile: {
    ...storedNodeBase,
    locator: FileObjectLocatorSchema,
    maximumBytes: ByteCountSchema,
    size: ByteCountSchema,
    contentType: Schema.NullOr(FileContentTypeSchema),
    digest: Schema.NullOr(ContentDigestSchema),
  },
})
/** Correct-by-construction live catalog record. */
export type StoredFileNode = Schema.Schema.Type<
  typeof StoredFileNodeSchema
>
/** Correct-by-construction live folder catalog record. */
export type StoredFolderNode = Extract<
  StoredFileNode,
  { readonly _tag: "Folder" }
>
/** Correct-by-construction live pending-file catalog record. */
export type StoredPendingFileNode = Extract<
  StoredFileNode,
  { readonly _tag: "PendingFile" }
>
/** Correct-by-construction live ready-file catalog record. */
export type StoredReadyFileNode = Extract<
  StoredFileNode,
  { readonly _tag: "ReadyFile" }
>

/** Catalog-level listing page before public projection. */
export interface CatalogFilePage {
  readonly items: ReadonlyArray<StoredFileNode>
  readonly cursor: PageCursor | null
}

/** Semantic outcomes of resolving and listing one target folder. */
export type CatalogListChildrenResult =
  | { readonly _tag: "Page"; readonly page: CatalogFilePage }
  | { readonly _tag: "TargetNotFound" }
  | { readonly _tag: "TargetNotFolder"; readonly fileId: FileId }
  | { readonly _tag: "InvalidCursor" }

/** Input common to actor-attributed file mutations. */
export interface CatalogMutationContext {
  readonly fileSystemId: FileSystemId
  readonly actor: FileActor
  readonly now: TimestampMillis
}

/** Atomic folder-create command supplied to a catalog. */
export interface CatalogCreateFolderInput extends CatalogMutationContext {
  readonly id: FileId
  readonly parentId: FileId | null
  readonly name: FileName
  readonly idempotencyKey: IdempotencyKey
}

/** Atomic upload-reservation command supplied to a catalog. */
export interface CatalogReserveUploadInput extends CatalogMutationContext {
  readonly id: FileId
  readonly parentId: FileId | null
  readonly name: FileName
  readonly idempotencyKey: IdempotencyKey
  readonly locator: FileObjectLocator
  readonly maximumBytes: ByteCount
  readonly pendingExpiresAt: TimestampMillis
}

/** Atomic pending-to-ready command supplied to a catalog. */
export interface CatalogConfirmUploadInput extends CatalogMutationContext {
  readonly fileId: FileId
  readonly size: ByteCount
  readonly contentType: FileContentType | null
  readonly digest: ContentDigest | null
  readonly quotaBytes: ByteCount
}

/** Atomic file rename command supplied to a catalog. */
export interface CatalogRenameFileInput extends CatalogMutationContext {
  readonly fileId: FileId
  readonly name: FileName
}

/** Atomic subtree soft-delete command supplied to a catalog. */
export interface CatalogSoftDeleteInput extends CatalogMutationContext {
  readonly fileId: FileId
  readonly reclaimAfter: TimestampMillis
}

/** Semantic outcomes of atomic folder creation. */
export type CatalogCreateFolderResult =
  | { readonly _tag: "Created"; readonly node: StoredFolderNode }
  | { readonly _tag: "ReplayFolder"; readonly node: StoredFolderNode }
  | { readonly _tag: "ReplayUnavailable"; readonly fileId: FileId }
  | { readonly _tag: "ParentNotFound" }
  | { readonly _tag: "ParentNotFolder"; readonly parentId: FileId }
  | { readonly _tag: "NameConflict" }
  | { readonly _tag: "IdempotencyConflict" }
  | { readonly _tag: "InvalidPath" }

/** Semantic outcomes of atomic upload reservation and replay. */
export type CatalogReserveUploadResult =
  | { readonly _tag: "Created"; readonly node: StoredPendingFileNode }
  | { readonly _tag: "ReplayPending"; readonly node: StoredPendingFileNode }
  | { readonly _tag: "ReplayReady"; readonly node: StoredReadyFileNode }
  | { readonly _tag: "ReplayUnavailable"; readonly fileId: FileId }
  | { readonly _tag: "ParentNotFound" }
  | { readonly _tag: "ParentNotFolder"; readonly parentId: FileId }
  | { readonly _tag: "NameConflict" }
  | { readonly _tag: "IdempotencyConflict" }
  | { readonly _tag: "InvalidPath" }

/** Semantic outcomes of atomic quota-aware confirmation. */
export type CatalogConfirmUploadResult =
  | { readonly _tag: "Confirmed"; readonly node: StoredReadyFileNode }
  | { readonly _tag: "AlreadyReady"; readonly node: StoredReadyFileNode }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "QuotaExceeded" }

/** Semantic outcomes of atomic rename. */
export type CatalogRenameFileResult =
  | {
      readonly _tag: "Renamed"
      readonly node: StoredPendingFileNode | StoredReadyFileNode
    }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "FolderNotSupported" }
  | { readonly _tag: "NameConflict" }
  | { readonly _tag: "InvalidPath" }

/** Semantic outcomes of atomic soft deletion. */
export type CatalogSoftDeleteResult =
  | { readonly _tag: "Deleted" }
  | { readonly _tag: "NotFound" }

/** Metadata catalog seam; adapters own isolation, uniqueness, and transition races. */
export interface FileCatalogService {
  readonly get: (
    fileSystemId: FileSystemId,
    fileId: FileId,
  ) => Effect.Effect<
    StoredFileNode | null,
    FileCatalogUnavailable | InvalidStoredFile
  >
  readonly listChildren: (
    fileSystemId: FileSystemId,
    target: FileListTarget,
    page: { readonly size: PageSize; readonly cursor: PageCursor | null },
  ) => Effect.Effect<
    CatalogListChildrenResult,
    FileCatalogUnavailable | InvalidStoredFile
  >
  readonly createFolder: (
    input: CatalogCreateFolderInput,
  ) => Effect.Effect<
    CatalogCreateFolderResult,
    FileCatalogUnavailable | InvalidStoredFile
  >
  readonly reserveUpload: (
    input: CatalogReserveUploadInput,
  ) => Effect.Effect<
    CatalogReserveUploadResult,
    FileCatalogUnavailable | InvalidStoredFile
  >
  readonly confirmUpload: (
    input: CatalogConfirmUploadInput,
  ) => Effect.Effect<
    CatalogConfirmUploadResult,
    FileCatalogUnavailable | InvalidStoredFile
  >
  readonly renameFile: (
    input: CatalogRenameFileInput,
  ) => Effect.Effect<
    CatalogRenameFileResult,
    FileCatalogUnavailable | InvalidStoredFile
  >
  readonly softDelete: (
    input: CatalogSoftDeleteInput,
  ) => Effect.Effect<
    CatalogSoftDeleteResult,
    FileCatalogUnavailable | InvalidStoredFile
  >
}

/** Effect service tag for the configured metadata catalog. */
export class FileCatalog extends Context.Service<
  FileCatalog,
  FileCatalogService
>()("@popcomputer/files/FileCatalog") {}

/** Metadata observed for one stored byte object. */
export interface FileObjectMetadata {
  readonly size: ByteCount
  readonly contentType: FileContentType | null
  readonly digest: ContentDigest | null
}

/** One issued capability URL and its absolute expiry. */
export interface IssuedFileCapability {
  readonly url: CapabilityUrl
  readonly expiresAt: TimestampMillis
}

/** Byte storage and capability seam used by the filesystem service. */
export interface FileObjectsService {
  /** Lifetime used for newly issued upload capabilities. */
  readonly uploadCapabilityTtlMillis: number
  /** Minimum delay before a tombstoned object can be reclaimed safely. */
  readonly reclamationGraceMillis: number
  readonly locationFor: (
    fileSystemId: FileSystemId,
    fileId: FileId,
  ) => FileObjectLocator
  readonly stat: (
    locator: FileObjectLocator,
  ) => Effect.Effect<FileObjectMetadata | null, FileObjectStoreUnavailable>
  readonly issueUpload: (input: {
    readonly locator: FileObjectLocator
    readonly maximumBytes: ByteCount
    readonly expiresAt: TimestampMillis
  }) => Effect.Effect<IssuedFileCapability, FileCapabilityUnavailable>
  readonly issueDownload: (input: {
    readonly locator: FileObjectLocator
    readonly fileName: FileName
  }) => Effect.Effect<IssuedFileCapability, FileCapabilityUnavailable>
  /** Idempotently remove one byte object; absence is success. */
  readonly delete: (
    locator: FileObjectLocator,
  ) => Effect.Effect<void, FileObjectStoreUnavailable>
}

/** One tombstoned file whose byte object is eligible for deletion. */
export interface FileReclamationCandidate {
  readonly fileSystemId: FileSystemId
  readonly fileId: FileId
  readonly locator: FileObjectLocator
}

/** Catalog operations reserved for bounded maintenance workers. */
export interface FileReclamationCatalogService {
  readonly expirePendingBatch: (input: {
    readonly actor: FileActor
    readonly now: TimestampMillis
    readonly reclaimAfter: TimestampMillis
    readonly limit: MaintenanceBatchSize
  }) => Effect.Effect<
    number,
    FileCatalogUnavailable | InvalidStoredFile
  >
  readonly listReclaimable: (input: {
    readonly now: TimestampMillis
    readonly limit: MaintenanceBatchSize
  }) => Effect.Effect<
    ReadonlyArray<FileReclamationCandidate>,
    FileCatalogUnavailable | InvalidStoredFile
  >
  readonly completeReclamation: (input: {
    readonly candidate: FileReclamationCandidate
    readonly now: TimestampMillis
  }) => Effect.Effect<void, FileCatalogUnavailable | InvalidStoredFile>
  readonly deferReclamation: (input: {
    readonly candidate: FileReclamationCandidate
    readonly retryAt: TimestampMillis
  }) => Effect.Effect<void, FileCatalogUnavailable | InvalidStoredFile>
  readonly purgeReclaimedBatch: (input: {
    readonly deletedBefore: TimestampMillis
    readonly limit: MaintenanceBatchSize
  }) => Effect.Effect<
    number,
    FileCatalogUnavailable | InvalidStoredFile
  >
}

/** Effect service tag for operational reclamation catalog access. */
export class FileReclamationCatalog extends Context.Service<
  FileReclamationCatalog,
  FileReclamationCatalogService
>()("@popcomputer/files/FileReclamationCatalog") {}

/** Effect service tag for byte inspection and capability issuance. */
export class FileObjects extends Context.Service<
  FileObjects,
  FileObjectsService
>()("@popcomputer/files/FileObjects") {}

/** Activity names emitted after committed filesystem operations. */
export type FileActivityAction =
  | "confirm_upload"
  | "create_folder"
  | "issue_download"
  | "rename_file"
  | "soft_delete"

/** Best-effort operational activity event. */
export interface FileActivity {
  readonly id: string
  readonly action: FileActivityAction
  readonly fileSystemId: FileSystemId
  readonly actor: FileActor
  readonly fileId: FileId
  readonly at: TimestampMillis
}

/** Best-effort operational-history seam; it is not a security audit log. */
export interface FileActivitySinkService {
  readonly record: (
    event: FileActivity,
  ) => Effect.Effect<void, FileActivityUnavailable>
}

/** Effect service tag for best-effort operational history. */
export class FileActivitySink extends Context.Service<
  FileActivitySink,
  FileActivitySinkService
>()("@popcomputer/files/FileActivitySink") {}

/** Injectable, non-reusing identity source for production and deterministic tests. */
export interface FileIdsService {
  /**
   * Emit a globally unique file identity that is never reissued while any
   * folder- or upload-request ledger retaining it can exist.
   */
  readonly nextFileId: Effect.Effect<FileId>
  readonly nextActivityId: Effect.Effect<string>
}

/** Effect service tag for file and activity identities. */
export class FileIds extends Context.Service<FileIds, FileIdsService>()(
  "@popcomputer/files/FileIds",
) {}

/** Production identity source backed by globally unique cryptographic UUIDs. */
export const randomUuidFileIdsLayer: Layer.Layer<FileIds> = Layer.succeed(
  FileIds,
  FileIds.of({
    nextFileId: Effect.sync(() => FileIdSchema.make(crypto.randomUUID())),
    nextActivityId: Effect.sync(() => crypto.randomUUID()),
  }),
)

/** Explicit sink for hosts that choose not to persist best-effort activity. */
export const discardFileActivityLayer: Layer.Layer<FileActivitySink> =
  Layer.succeed(
    FileActivitySink,
    FileActivitySink.of({ record: () => Effect.void }),
  )

/** Project an internal catalog record to the public node state. */
export function toPublicFileNode(node: StoredFolderNode): FolderNode
/** Project an internal catalog record to the public node state. */
export function toPublicFileNode(node: StoredPendingFileNode): PendingFileNode
/** Project an internal catalog record to the public node state. */
export function toPublicFileNode(node: StoredReadyFileNode): ReadyFileNode
/** Project an internal catalog record to the public node state. */
export function toPublicFileNode(
  node: StoredPendingFileNode | StoredReadyFileNode,
): PendingFileNode | ReadyFileNode
/** Project an internal catalog record to the public node state. */
export function toPublicFileNode(node: StoredFileNode): FileNode
export function toPublicFileNode(node: StoredFileNode): FileNode {
  switch (node._tag) {
    case "Folder":
      return {
        _tag: "Folder",
        id: node.id,
        parentId: node.parentId,
        name: node.name,
        path: node.path,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
      }
    case "PendingFile":
      return {
        _tag: "PendingFile",
        id: node.id,
        parentId: node.parentId,
        name: node.name,
        path: node.path,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
      }
    case "ReadyFile":
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
}
