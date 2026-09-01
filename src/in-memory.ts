import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  SynchronizedRef,
} from "effect"
import {
  FileActivitySink,
  FileCatalog,
  FileIds,
  FileObjectLocatorSchema,
  FileObjects,
  FileReclamationCatalog,
  StoredFileNodeSchema,
  type CatalogConfirmUploadInput,
  type CatalogConfirmUploadResult,
  type CatalogCreateFolderInput,
  type CatalogCreateFolderResult,
  type CatalogFilePage,
  type CatalogListChildrenResult,
  type CatalogRenameFileInput,
  type CatalogRenameFileResult,
  type CatalogReserveUploadInput,
  type CatalogReserveUploadResult,
  type CatalogSoftDeleteInput,
  type CatalogSoftDeleteResult,
  type FileActivity,
  type FileObjectLocator,
  type FileObjectMetadata,
  type FileReclamationCandidate,
  type IssuedFileCapability,
  type StoredFileNode,
} from "./adapter.js"
import {
  FileActivityUnavailable,
  FileObjectStoreUnavailable,
  InvalidStoredFile,
} from "./errors.js"
import {
  CapabilityUrlSchema,
  FileIdSchema,
  PageCursorSchema,
  TimestampMillisSchema,
  childPath,
  replacePathLeaf,
  type ByteCount,
  type FileId,
  type FileListTarget,
  type FileName,
  type FileSystemId,
  type IdempotencyKey,
  type MaintenanceBatchSize,
  type PageCursor,
  type PageSize,
  type RelativePath,
  type TimestampMillis,
} from "./file.js"
import {
  FileTestControl,
  type TestIssuedFileCapability,
} from "./testing.js"

interface CatalogRecord {
  readonly fileSystemId: FileSystemId
  readonly node: StoredFileNode
  readonly deletedAt: TimestampMillis | null
  readonly reclaimAfter: TimestampMillis | null
  readonly objectReclaimedAt: TimestampMillis | null
}

interface UploadLedgerEntry {
  readonly fileSystemId: FileSystemId
  readonly idempotencyKey: IdempotencyKey
  readonly fileId: FileId
  readonly parentId: FileId | null
  readonly name: FileName
  readonly maximumBytes: ByteCount
}

interface FolderLedgerEntry {
  readonly fileSystemId: FileSystemId
  readonly idempotencyKey: IdempotencyKey
  readonly fileId: FileId
  readonly parentId: FileId | null
  readonly name: FileName
}

interface CatalogState {
  readonly records: ReadonlyMap<string, CatalogRecord>
  readonly folders: ReadonlyMap<string, FolderLedgerEntry>
  readonly uploads: ReadonlyMap<string, UploadLedgerEntry>
  readonly cursors: ReadonlyMap<PageCursor, StoredCursor>
  readonly nextCursor: number
}

interface ObjectState {
  readonly metadata: ReadonlyMap<FileObjectLocator, FileObjectMetadata>
  readonly capabilities: ReadonlyArray<TestIssuedFileCapability>
  readonly deleteAttempts: ReadonlyArray<FileObjectLocator>
  readonly nextCapability: number
  readonly failNextDelete: boolean
}

interface ActivityState {
  readonly events: ReadonlyArray<FileActivity>
  readonly failNext: boolean
}

interface IdentityState {
  readonly nextFile: number
  readonly nextActivity: number
}

interface CursorPayload {
  readonly kind: "Folder" | "File"
  readonly name: string
  readonly id: string
}

interface StoredCursor {
  readonly fileSystemId: FileSystemId
  readonly parentId: FileId | null
  readonly position: CursorPayload
}

interface KeysetPage {
  readonly items: ReadonlyArray<StoredFileNode>
  readonly next: CursorPayload | null
}

const capabilityLifetimeMillis = 5 * 60 * 1000
const textEncoder = new TextEncoder()

const catalogKey = (fileSystemId: FileSystemId, fileId: FileId): string =>
  `${fileSystemId}\u0000${fileId}`

const uploadKey = (
  fileSystemId: FileSystemId,
  idempotencyKey: IdempotencyKey,
): string => `${fileSystemId}\u0000${idempotencyKey}`

const folderKey = (
  fileSystemId: FileSystemId,
  idempotencyKey: IdempotencyKey,
): string => `${fileSystemId}\u0000${idempotencyKey}`

const objectLocator = (
  fileSystemId: FileSystemId,
  fileId: FileId,
): FileObjectLocator =>
  FileObjectLocatorSchema.make(
    `memory:${fileSystemId.length}:${fileSystemId}:${fileId}`,
  )

const findLiveRecord = (
  state: CatalogState,
  fileSystemId: FileSystemId,
  fileId: FileId,
): CatalogRecord | null => {
  const record = state.records.get(catalogKey(fileSystemId, fileId))
  return record === undefined || record.deletedAt !== null ? null : record
}

const liveRecords = (
  state: CatalogState,
  fileSystemId: FileSystemId,
): ReadonlyArray<CatalogRecord> => {
  const records: Array<CatalogRecord> = []
  for (const record of state.records.values()) {
    if (
      record.deletedAt === null &&
      record.fileSystemId === fileSystemId
    ) {
      records.push(record)
    }
  }
  return records
}

const hasSiblingName = (
  state: CatalogState,
  fileSystemId: FileSystemId,
  parentId: FileId | null,
  name: FileName,
  exceptFileId: FileId | null,
): boolean => {
  for (const record of liveRecords(state, fileSystemId)) {
    if (
      record.node.parentId === parentId &&
      record.node.name === name &&
      record.node.id !== exceptFileId
    ) {
      return true
    }
  }
  return false
}

const compareText = (left: string, right: string): number => {
  const leftBytes = textEncoder.encode(left)
  const rightBytes = textEncoder.encode(right)
  const sharedLength = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0)
    if (difference !== 0) return difference
  }
  return leftBytes.length - rightBytes.length
}

const cursorPayload = (node: StoredFileNode): CursorPayload => ({
  kind: node._tag === "Folder" ? "Folder" : "File",
  name: node.name,
  id: node.id,
})

const cursorKindRank = (kind: CursorPayload["kind"]): number =>
  kind === "Folder" ? 0 : 1

const compareCursorPayload = (
  left: CursorPayload,
  right: CursorPayload,
): number => {
  const kindComparison = cursorKindRank(left.kind) - cursorKindRank(right.kind)
  if (kindComparison !== 0) return kindComparison
  const nameComparison = compareText(left.name, right.name)
  return nameComparison !== 0 ? nameComparison : compareText(left.id, right.id)
}

const compareNodes = (left: StoredFileNode, right: StoredFileNode): number =>
  compareCursorPayload(cursorPayload(left), cursorPayload(right))

const pageChildren = (
  nodes: ReadonlyArray<StoredFileNode>,
  size: PageSize,
  cursor: CursorPayload | null,
): KeysetPage => {
  const sorted = [...nodes].sort(compareNodes)
  const afterCursor =
    cursor === null
      ? sorted
      : sorted.filter(
          (node) =>
            compareCursorPayload(cursorPayload(node), cursor) > 0,
        )
  const items = afterCursor.slice(0, size)
  const last = items.at(-1)
  const next =
    afterCursor.length > size && last !== undefined
      ? cursorPayload(last)
      : null
  return { items, next }
}

const resolveListParent = (
  state: CatalogState,
  fileSystemId: FileSystemId,
  target: FileListTarget,
):
  | { readonly _tag: "Parent"; readonly parentId: FileId | null }
  | { readonly _tag: "TargetNotFound" }
  | { readonly _tag: "TargetNotFolder"; readonly fileId: FileId } => {
  switch (target._tag) {
    case "Root":
      return { _tag: "Parent", parentId: null }
    case "FolderId": {
      const record = findLiveRecord(state, fileSystemId, target.id)
      if (record === null) return { _tag: "TargetNotFound" }
      if (record.node._tag !== "Folder") {
        return { _tag: "TargetNotFolder", fileId: record.node.id }
      }
      return { _tag: "Parent", parentId: record.node.id }
    }
    case "Path": {
      const record = liveRecords(state, fileSystemId).find(
        (candidate) => candidate.node.path === target.path,
      )
      if (record === undefined) return { _tag: "TargetNotFound" }
      if (record.node._tag !== "Folder") {
        return { _tag: "TargetNotFolder", fileId: record.node.id }
      }
      return { _tag: "Parent", parentId: record.node.id }
    }
  }
}

const parentPath = (
  state: CatalogState,
  fileSystemId: FileSystemId,
  parentId: FileId | null,
):
  | { readonly _tag: "Parent"; readonly path: RelativePath | null }
  | { readonly _tag: "ParentNotFound" }
  | { readonly _tag: "ParentNotFolder"; readonly parentId: FileId } => {
  if (parentId === null) return { _tag: "Parent", path: null }
  const record = findLiveRecord(state, fileSystemId, parentId)
  if (record === null) return { _tag: "ParentNotFound" }
  if (record.node._tag !== "Folder") {
    return { _tag: "ParentNotFolder", parentId }
  }
  return { _tag: "Parent", path: record.node.path }
}

const putCatalogRecord = (
  state: CatalogState,
  record: CatalogRecord,
): CatalogState => {
  const records = new Map(state.records)
  records.set(catalogKey(record.fileSystemId, record.node.id), record)
  return { ...state, records }
}

const orderNodesByPath = (
  left: StoredFileNode,
  right: StoredFileNode,
): number => {
  const pathComparison = compareText(left.path, right.path)
  return pathComparison !== 0
    ? pathComparison
    : compareText(left.id, right.id)
}

/** Construct fresh, deterministic in-memory implementations of every adapter seam. */
export const layer = (): Layer.Layer<
  | FileCatalog
  | FileObjects
  | FileReclamationCatalog
  | FileActivitySink
  | FileIds
  | FileTestControl
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const catalogState = yield* SynchronizedRef.make<CatalogState>({
        records: new Map(),
        folders: new Map(),
        uploads: new Map(),
        cursors: new Map(),
        nextCursor: 1,
      })
      const objectState = yield* Ref.make<ObjectState>({
        metadata: new Map(),
        capabilities: [],
        deleteAttempts: [],
        nextCapability: 1,
        failNextDelete: false,
      })
      const activityState = yield* Ref.make<ActivityState>({
        events: [],
        failNext: false,
      })
      const identityState = yield* Ref.make<IdentityState>({
        nextFile: 1,
        nextActivity: 1,
      })

      const get = Effect.fn("InMemoryFileCatalog.get")(function* (
        fileSystemId: FileSystemId,
        fileId: FileId,
      ) {
        const state = yield* SynchronizedRef.get(catalogState)
        return findLiveRecord(state, fileSystemId, fileId)?.node ?? null
      })

      const listChildren = Effect.fn(
        "InMemoryFileCatalog.listChildren",
      )(function* (
        fileSystemId: FileSystemId,
        target: FileListTarget,
        page: { readonly size: PageSize; readonly cursor: PageCursor | null },
      ) {
        return yield* SynchronizedRef.modify<
          CatalogState,
          CatalogListChildrenResult
        >(catalogState, (state) => {
          const parent = resolveListParent(state, fileSystemId, target)
          if (parent._tag !== "Parent") return [parent, state] as const

          const storedCursor =
            page.cursor === null ? undefined : state.cursors.get(page.cursor)
          if (
            page.cursor !== null &&
            (storedCursor === undefined ||
              storedCursor.fileSystemId !== fileSystemId ||
              storedCursor.parentId !== parent.parentId)
          ) {
            return [{ _tag: "InvalidCursor" }, state] as const
          }

          const children = liveRecords(state, fileSystemId).flatMap((record) =>
            record.node.parentId === parent.parentId ? [record.node] : [],
          )
          const keysetPage = pageChildren(
            children,
            page.size,
            storedCursor?.position ?? null,
          )
          if (keysetPage.next === null) {
            const result: CatalogListChildrenResult = {
              _tag: "Page",
              page: { items: keysetPage.items, cursor: null },
            }
            return [result, state] as const
          }

          const cursor = PageCursorSchema.make(
            `cursor-${String(state.nextCursor).padStart(8, "0")}`,
          )
          const cursors = new Map(state.cursors)
          cursors.set(cursor, {
            fileSystemId,
            parentId: parent.parentId,
            position: keysetPage.next,
          })
          const catalogPage: CatalogFilePage = {
            items: keysetPage.items,
            cursor,
          }
          const result: CatalogListChildrenResult = {
            _tag: "Page",
            page: catalogPage,
          }
          return [
            result,
            { ...state, cursors, nextCursor: state.nextCursor + 1 },
          ] as const
        })
      })

      const createFolder = Effect.fn(
        "InMemoryFileCatalog.createFolder",
      )(function* (input: CatalogCreateFolderInput) {
        return yield* SynchronizedRef.modifyEffect<
          CatalogState,
          CatalogCreateFolderResult,
          InvalidStoredFile,
          never
        >(
          catalogState,
          (state) =>
            Effect.gen(function* () {
              const ledgerKey = folderKey(
                input.fileSystemId,
                input.idempotencyKey,
              )
              const replay = state.folders.get(ledgerKey)
              if (replay !== undefined) {
                const sameFingerprint =
                  replay.parentId === input.parentId &&
                  replay.name === input.name
                if (!sameFingerprint) {
                  const result: CatalogCreateFolderResult = {
                    _tag: "IdempotencyConflict",
                  }
                  return [result, state] as const
                }
                const record = findLiveRecord(
                  state,
                  input.fileSystemId,
                  replay.fileId,
                )
                if (record === null) {
                  const result: CatalogCreateFolderResult = {
                    _tag: "ReplayUnavailable",
                    fileId: replay.fileId,
                  }
                  return [result, state] as const
                }
                if (record.node._tag !== "Folder") {
                  return yield* Effect.fail(
                    new InvalidStoredFile({
                      reason: "folder request identity does not refer to a folder",
                    }),
                  )
                }
                const result: CatalogCreateFolderResult = {
                  _tag: "ReplayFolder",
                  node: record.node,
                }
                return [result, state] as const
              }

              if (
                state.records.has(
                  catalogKey(input.fileSystemId, input.id),
                )
              ) {
                return yield* Effect.fail(
                  new InvalidStoredFile({
                    reason: "file identity already exists in this filesystem",
                  }),
                )
              }

              const parent = parentPath(
                state,
                input.fileSystemId,
                input.parentId,
              )
              if (parent._tag !== "Parent") {
                const result: CatalogCreateFolderResult = parent
                return [result, state] as const
              }
              if (
                hasSiblingName(
                  state,
                  input.fileSystemId,
                  input.parentId,
                  input.name,
                  null,
                )
              ) {
                const result: CatalogCreateFolderResult = {
                  _tag: "NameConflict",
                }
                return [result, state] as const
              }

              const maybePath = yield* Effect.option(
                childPath(parent.path, input.name),
              )
              if (Option.isNone(maybePath)) {
                const result: CatalogCreateFolderResult = {
                  _tag: "InvalidPath",
                }
                return [result, state] as const
              }

              const node = StoredFileNodeSchema.cases.Folder.make({
                id: input.id,
                parentId: input.parentId,
                name: input.name,
                path: maybePath.value,
                createdAt: input.now,
                updatedAt: input.now,
              })
              const withRecord = putCatalogRecord(state, {
                fileSystemId: input.fileSystemId,
                node,
                deletedAt: null,
                reclaimAfter: null,
                objectReclaimedAt: null,
              })
              const folders = new Map(withRecord.folders)
              folders.set(ledgerKey, {
                fileSystemId: input.fileSystemId,
                idempotencyKey: input.idempotencyKey,
                fileId: input.id,
                parentId: input.parentId,
                name: input.name,
              })
              const result: CatalogCreateFolderResult = {
                _tag: "Created",
                node,
              }
              return [result, { ...withRecord, folders }] as const
            }),
        )
      })

      const reserveUpload = Effect.fn(
        "InMemoryFileCatalog.reserveUpload",
      )(function* (input: CatalogReserveUploadInput) {
        return yield* SynchronizedRef.modifyEffect<
          CatalogState,
          CatalogReserveUploadResult,
          InvalidStoredFile,
          never
        >(
          catalogState,
          (state) =>
            Effect.gen(function* () {
              const ledgerKey = uploadKey(
                input.fileSystemId,
                input.idempotencyKey,
              )
              const replay = state.uploads.get(ledgerKey)
              if (replay !== undefined) {
                const sameFingerprint =
                  replay.parentId === input.parentId &&
                  replay.name === input.name &&
                  replay.maximumBytes === input.maximumBytes
                if (!sameFingerprint) {
                  const result: CatalogReserveUploadResult = {
                    _tag: "IdempotencyConflict",
                  }
                  return [result, state] as const
                }
                const record = findLiveRecord(
                  state,
                  input.fileSystemId,
                  replay.fileId,
                )
                if (record === null || record.node._tag === "Folder") {
                  const result: CatalogReserveUploadResult = {
                    _tag: "ReplayUnavailable",
                    fileId: replay.fileId,
                  }
                  return [result, state] as const
                }
                if (record.node._tag === "ReadyFile") {
                  const result: CatalogReserveUploadResult = {
                    _tag: "ReplayReady",
                    node: record.node,
                  }
                  return [result, state] as const
                }

                const pendingExpiresAt = TimestampMillisSchema.make(
                  Math.max(
                    record.node.pendingExpiresAt,
                    input.pendingExpiresAt,
                  ),
                )
                const replayed = StoredFileNodeSchema.cases.PendingFile.make({
                  ...record.node,
                  pendingExpiresAt,
                })
                const next = putCatalogRecord(state, {
                  ...record,
                  node: replayed,
                })
                const result: CatalogReserveUploadResult = {
                  _tag: "ReplayPending",
                  node: replayed,
                }
                return [result, next] as const
              }

              if (
                state.records.has(
                  catalogKey(input.fileSystemId, input.id),
                )
              ) {
                return yield* Effect.fail(
                  new InvalidStoredFile({
                    reason: "file identity already exists in this filesystem",
                  }),
                )
              }

              const parent = parentPath(
                state,
                input.fileSystemId,
                input.parentId,
              )
              if (parent._tag !== "Parent") {
                const result: CatalogReserveUploadResult = parent
                return [result, state] as const
              }
              if (
                hasSiblingName(
                  state,
                  input.fileSystemId,
                  input.parentId,
                  input.name,
                  null,
                )
              ) {
                const result: CatalogReserveUploadResult = {
                  _tag: "NameConflict",
                }
                return [result, state] as const
              }

              const maybePath = yield* Effect.option(
                childPath(parent.path, input.name),
              )
              if (Option.isNone(maybePath)) {
                const result: CatalogReserveUploadResult = {
                  _tag: "InvalidPath",
                }
                return [result, state] as const
              }

              const node = StoredFileNodeSchema.cases.PendingFile.make({
                id: input.id,
                parentId: input.parentId,
                name: input.name,
                path: maybePath.value,
                createdAt: input.now,
                updatedAt: input.now,
                locator: input.locator,
                maximumBytes: input.maximumBytes,
                pendingExpiresAt: input.pendingExpiresAt,
              })
              const withRecord = putCatalogRecord(state, {
                fileSystemId: input.fileSystemId,
                node,
                deletedAt: null,
                reclaimAfter: null,
                objectReclaimedAt: null,
              })
              const uploads = new Map(withRecord.uploads)
              uploads.set(ledgerKey, {
                fileSystemId: input.fileSystemId,
                idempotencyKey: input.idempotencyKey,
                fileId: input.id,
                parentId: input.parentId,
                name: input.name,
                maximumBytes: input.maximumBytes,
              })
              const next: CatalogState = { ...withRecord, uploads }
              const result: CatalogReserveUploadResult = {
                _tag: "Created",
                node,
              }
              return [result, next] as const
            }),
        )
      })

      const confirmUpload = Effect.fn(
        "InMemoryFileCatalog.confirmUpload",
      )(function* (input: CatalogConfirmUploadInput) {
        return yield* SynchronizedRef.modifyEffect<
          CatalogState,
          CatalogConfirmUploadResult,
          InvalidStoredFile,
          never
        >(
          catalogState,
          (state) =>
            Effect.gen(function* () {
              const record = findLiveRecord(
                state,
                input.fileSystemId,
                input.fileId,
              )
              if (record === null || record.node._tag === "Folder") {
                const result: CatalogConfirmUploadResult = {
                  _tag: "NotFound",
                }
                return [result, state] as const
              }
              if (record.node._tag === "ReadyFile") {
                const result: CatalogConfirmUploadResult = {
                  _tag: "AlreadyReady",
                  node: record.node,
                }
                return [result, state] as const
              }
              if (input.size > record.node.maximumBytes) {
                return yield* Effect.fail(
                  new InvalidStoredFile({
                    reason: "confirmed size exceeds the reserved upload bound",
                  }),
                )
              }

              let usedBytes = 0
              for (const candidate of state.records.values()) {
                if (
                  candidate.deletedAt === null &&
                  candidate.fileSystemId === input.fileSystemId &&
                  candidate.node._tag === "ReadyFile"
                ) {
                  usedBytes += candidate.node.size
                }
              }
              if (usedBytes + input.size > input.quotaBytes) {
                const result: CatalogConfirmUploadResult = {
                  _tag: "QuotaExceeded",
                }
                return [result, state] as const
              }

              const decoded = yield* Schema.decodeUnknownEffect(
                StoredFileNodeSchema,
              )({
                _tag: "ReadyFile",
                id: record.node.id,
                parentId: record.node.parentId,
                name: record.node.name,
                path: record.node.path,
                createdAt: record.node.createdAt,
                updatedAt: input.now,
                locator: record.node.locator,
                maximumBytes: record.node.maximumBytes,
                size: input.size,
                contentType: input.contentType,
                digest: input.digest,
              }).pipe(
                Effect.mapError(
                  () =>
                    new InvalidStoredFile({
                      reason: "confirmed object metadata is invalid",
                    }),
                ),
              )
              if (decoded._tag !== "ReadyFile") {
                return yield* Effect.fail(
                  new InvalidStoredFile({
                    reason: "confirmation did not produce a ready file",
                  }),
                )
              }

              const next = putCatalogRecord(state, {
                ...record,
                node: decoded,
              })
              const result: CatalogConfirmUploadResult = {
                _tag: "Confirmed",
                node: decoded,
              }
              return [result, next] as const
            }),
        )
      })

      const renameFile = Effect.fn(
        "InMemoryFileCatalog.renameFile",
      )(function* (input: CatalogRenameFileInput) {
        return yield* SynchronizedRef.modifyEffect<
          CatalogState,
          CatalogRenameFileResult,
          never,
          never
        >(
          catalogState,
          (state) =>
            Effect.gen(function* () {
              const record = findLiveRecord(
                state,
                input.fileSystemId,
                input.fileId,
              )
              if (record === null) {
                const result: CatalogRenameFileResult = { _tag: "NotFound" }
                return [result, state] as const
              }
              if (record.node._tag === "Folder") {
                const result: CatalogRenameFileResult = {
                  _tag: "FolderNotSupported",
                }
                return [result, state] as const
              }
              if (
                hasSiblingName(
                  state,
                  input.fileSystemId,
                  record.node.parentId,
                  input.name,
                  record.node.id,
                )
              ) {
                const result: CatalogRenameFileResult = {
                  _tag: "NameConflict",
                }
                return [result, state] as const
              }

              const maybePath = yield* Effect.option(
                replacePathLeaf(record.node.path, input.name),
              )
              if (Option.isNone(maybePath)) {
                const result: CatalogRenameFileResult = {
                  _tag: "InvalidPath",
                }
                return [result, state] as const
              }

              const renamed =
                record.node._tag === "PendingFile"
                  ? StoredFileNodeSchema.cases.PendingFile.make({
                      id: record.node.id,
                      parentId: record.node.parentId,
                      name: input.name,
                      path: maybePath.value,
                      createdAt: record.node.createdAt,
                      updatedAt: input.now,
                      locator: record.node.locator,
                      maximumBytes: record.node.maximumBytes,
                      pendingExpiresAt: record.node.pendingExpiresAt,
                    })
                  : StoredFileNodeSchema.cases.ReadyFile.make({
                      id: record.node.id,
                      parentId: record.node.parentId,
                      name: input.name,
                      path: maybePath.value,
                      createdAt: record.node.createdAt,
                      updatedAt: input.now,
                      locator: record.node.locator,
                      maximumBytes: record.node.maximumBytes,
                      size: record.node.size,
                      contentType: record.node.contentType,
                      digest: record.node.digest,
                    })
              const next = putCatalogRecord(state, {
                ...record,
                node: renamed,
              })
              const result: CatalogRenameFileResult = {
                _tag: "Renamed",
                node: renamed,
              }
              return [result, next] as const
            }),
        )
      })

      const softDelete = Effect.fn(
        "InMemoryFileCatalog.softDelete",
      )(function* (input: CatalogSoftDeleteInput) {
        return yield* SynchronizedRef.modify<
          CatalogState,
          CatalogSoftDeleteResult
        >(catalogState, (state) => {
          const target = findLiveRecord(
            state,
            input.fileSystemId,
            input.fileId,
          )
          if (target === null) {
            const result: CatalogSoftDeleteResult = { _tag: "NotFound" }
            return [result, state] as const
          }

          const deletedIds = new Set<FileId>([target.node.id])
          let discoveredDescendant = true
          while (discoveredDescendant) {
            discoveredDescendant = false
            for (const record of liveRecords(state, input.fileSystemId)) {
              if (
                record.node.parentId !== null &&
                deletedIds.has(record.node.parentId) &&
                !deletedIds.has(record.node.id)
              ) {
                deletedIds.add(record.node.id)
                discoveredDescendant = true
              }
            }
          }

          const records = new Map(state.records)
          for (const [key, record] of state.records) {
            if (
              record.deletedAt === null &&
              record.fileSystemId === input.fileSystemId &&
              deletedIds.has(record.node.id)
            ) {
              records.set(key, {
                ...record,
                deletedAt: input.now,
                reclaimAfter:
                  record.node._tag === "PendingFile"
                    ? TimestampMillisSchema.make(
                        Math.max(
                          record.node.pendingExpiresAt,
                          input.reclaimAfter,
                        ),
                      )
                    : input.reclaimAfter,
                objectReclaimedAt: null,
              })
            }
          }
          const result: CatalogSoftDeleteResult = { _tag: "Deleted" }
          return [result, { ...state, records }] as const
        })
      })

      const catalog = FileCatalog.of({
        get,
        listChildren,
        createFolder,
        reserveUpload,
        confirmUpload,
        renameFile,
        softDelete,
      })

      const expirePendingBatch = Effect.fn(
        "InMemoryFileReclamationCatalog.expirePendingBatch",
      )(function* (input: {
        readonly actor: FileActivity["actor"]
        readonly now: TimestampMillis
        readonly reclaimAfter: TimestampMillis
        readonly limit: MaintenanceBatchSize
      }) {
        return yield* SynchronizedRef.modify<CatalogState, number>(
          catalogState,
          (state) => {
            const expired = [...state.records.entries()]
              .filter(([, record]) =>
                record.deletedAt === null &&
                record.node._tag === "PendingFile" &&
                record.node.pendingExpiresAt <= input.now
              )
              .sort(([, left], [, right]) => {
                if (
                  left.node._tag !== "PendingFile" ||
                  right.node._tag !== "PendingFile"
                ) {
                  return 0
                }
                const expiry =
                  left.node.pendingExpiresAt -
                  right.node.pendingExpiresAt
                if (expiry !== 0) return expiry
                const system = compareText(
                  left.fileSystemId,
                  right.fileSystemId,
                )
                return system !== 0
                  ? system
                  : compareText(left.node.id, right.node.id)
              })
              .slice(0, input.limit)

            if (expired.length === 0) return [0, state] as const

            const records = new Map(state.records)
            for (const [key, record] of expired) {
              records.set(key, {
                ...record,
                deletedAt: input.now,
                reclaimAfter: input.reclaimAfter,
                objectReclaimedAt: null,
              })
            }
            return [expired.length, { ...state, records }] as const
          },
        )
      })

      const listReclaimable = Effect.fn(
        "InMemoryFileReclamationCatalog.listReclaimable",
      )(function* (input: {
        readonly now: TimestampMillis
        readonly limit: MaintenanceBatchSize
      }) {
        const state = yield* SynchronizedRef.get(catalogState)
        return [...state.records.values()]
          .filter(
            (record) =>
              record.deletedAt !== null &&
              record.reclaimAfter !== null &&
              record.reclaimAfter <= input.now &&
              record.objectReclaimedAt === null &&
              record.node._tag !== "Folder",
          )
          .sort((left, right) => {
            const reclaimAfter =
              (left.reclaimAfter ?? 0) - (right.reclaimAfter ?? 0)
            if (reclaimAfter !== 0) return reclaimAfter
            const system = compareText(
              left.fileSystemId,
              right.fileSystemId,
            )
            return system !== 0
              ? system
              : compareText(left.node.id, right.node.id)
          })
          .slice(0, input.limit)
          .flatMap((record): ReadonlyArray<FileReclamationCandidate> =>
            record.node._tag === "Folder"
              ? []
              : [
                  {
                    fileSystemId: record.fileSystemId,
                    fileId: record.node.id,
                    locator: record.node.locator,
                  },
                ],
          )
      })

      const completeReclamation = Effect.fn(
        "InMemoryFileReclamationCatalog.completeReclamation",
      )(function* (input: {
        readonly candidate: FileReclamationCandidate
        readonly now: TimestampMillis
      }) {
        yield* SynchronizedRef.update(catalogState, (state) => {
          const key = catalogKey(
            input.candidate.fileSystemId,
            input.candidate.fileId,
          )
          const record = state.records.get(key)
          if (
            record === undefined ||
            record.deletedAt === null ||
            record.reclaimAfter === null ||
            record.reclaimAfter > input.now ||
            record.objectReclaimedAt !== null ||
            record.node._tag === "Folder" ||
            record.node.locator !== input.candidate.locator
          ) {
            return state
          }
          const records = new Map(state.records)
          records.set(key, {
            ...record,
            objectReclaimedAt: input.now,
          })
          return { ...state, records }
        })
      })

      const deferReclamation = Effect.fn(
        "InMemoryFileReclamationCatalog.deferReclamation",
      )(function* (input: {
        readonly candidate: FileReclamationCandidate
        readonly retryAt: TimestampMillis
      }) {
        yield* SynchronizedRef.update(catalogState, (state) => {
          const key = catalogKey(
            input.candidate.fileSystemId,
            input.candidate.fileId,
          )
          const record = state.records.get(key)
          if (
            record === undefined ||
            record.deletedAt === null ||
            record.objectReclaimedAt !== null ||
            record.node._tag === "Folder" ||
            record.node.locator !== input.candidate.locator
          ) {
            return state
          }
          const records = new Map(state.records)
          records.set(key, {
            ...record,
            reclaimAfter: TimestampMillisSchema.make(
              Math.max(record.reclaimAfter ?? 0, input.retryAt),
            ),
          })
          return { ...state, records }
        })
      })

      const purgeReclaimedBatch = Effect.fn(
        "InMemoryFileReclamationCatalog.purgeReclaimedBatch",
      )(function* (input: {
        readonly deletedBefore: TimestampMillis
        readonly limit: MaintenanceBatchSize
      }) {
        return yield* SynchronizedRef.modify<CatalogState, number>(
          catalogState,
          (state) => {
            const eligible = [...state.records.entries()]
              .filter(([, record]) => {
                if (
                  record.deletedAt === null ||
                  record.deletedAt > input.deletedBefore
                ) {
                  return false
                }
                if (record.node._tag !== "Folder") {
                  return record.objectReclaimedAt !== null
                }
                for (const candidate of state.records.values()) {
                  if (
                    candidate.fileSystemId === record.fileSystemId &&
                    candidate.node.parentId === record.node.id
                  ) {
                    return false
                  }
                }
                return true
              })
              .sort(([, left], [, right]) => {
                const kind =
                  (left.node._tag === "Folder" ? 1 : 0) -
                  (right.node._tag === "Folder" ? 1 : 0)
                if (kind !== 0) return kind
                const deletedAt =
                  (left.deletedAt ?? 0) - (right.deletedAt ?? 0)
                if (deletedAt !== 0) return deletedAt
                const system = compareText(
                  left.fileSystemId,
                  right.fileSystemId,
                )
                return system !== 0
                  ? system
                  : compareText(left.node.id, right.node.id)
              })
              .slice(0, input.limit)

            if (eligible.length === 0) return [0, state] as const

            const records = new Map(state.records)
            for (const [key] of eligible) records.delete(key)
            return [eligible.length, { ...state, records }] as const
          },
        )
      })

      const reclamation = FileReclamationCatalog.of({
        expirePendingBatch,
        listReclaimable,
        completeReclamation,
        deferReclamation,
        purgeReclaimedBatch,
      })

      const stat = Effect.fn("InMemoryFileObjects.stat")(function* (
        locator: FileObjectLocator,
      ) {
        const state = yield* Ref.get(objectState)
        return state.metadata.get(locator) ?? null
      })

      const issueUpload = Effect.fn(
        "InMemoryFileObjects.issueUpload",
      )(function* (input) {
        return yield* Ref.modify(objectState, (state) => {
          const capability: IssuedFileCapability = {
            url: CapabilityUrlSchema.make(
              `https://in-memory.invalid/upload/${state.nextCapability}`,
            ),
            expiresAt: input.expiresAt,
          }
          const observed: TestIssuedFileCapability = {
            _tag: "Upload",
            locator: input.locator,
            maximumBytes: input.maximumBytes,
            capability,
          }
          return [
            capability,
            {
              ...state,
              capabilities: [...state.capabilities, observed],
              nextCapability: state.nextCapability + 1,
            },
          ] as const
        })
      })

      const issueDownload = Effect.fn(
        "InMemoryFileObjects.issueDownload",
      )(function* (input) {
        const now = yield* Clock.currentTimeMillis
        return yield* Ref.modify(objectState, (state) => {
          const capability: IssuedFileCapability = {
            url: CapabilityUrlSchema.make(
              `https://in-memory.invalid/download/${state.nextCapability}`,
            ),
            expiresAt: TimestampMillisSchema.make(
              now + capabilityLifetimeMillis,
            ),
          }
          const observed: TestIssuedFileCapability = {
            _tag: "Download",
            locator: input.locator,
            fileName: input.fileName,
            capability,
          }
          return [
            capability,
            {
              ...state,
              capabilities: [...state.capabilities, observed],
              nextCapability: state.nextCapability + 1,
            },
          ] as const
        })
      })

      const deleteObject = Effect.fn(
        "InMemoryFileObjects.delete",
      )(function* (locator: FileObjectLocator) {
        const shouldFail = yield* Ref.modify(objectState, (state) => {
          const deleteAttempts = [...state.deleteAttempts, locator]
          if (state.failNextDelete) {
            return [
              true,
              {
                ...state,
                deleteAttempts,
                failNextDelete: false,
              },
            ] as const
          }
          const metadata = new Map(state.metadata)
          metadata.delete(locator)
          return [
            false,
            { ...state, metadata, deleteAttempts },
          ] as const
        })
        if (shouldFail) {
          return yield* Effect.fail(
            new FileObjectStoreUnavailable({
              operation: "delete",
              cause: new Error(
                "in-memory object deletion failure requested by test",
              ),
            }),
          )
        }
      })

      const objects = FileObjects.of({
        uploadCapabilityTtlMillis: capabilityLifetimeMillis,
        reclamationGraceMillis: capabilityLifetimeMillis,
        locationFor: objectLocator,
        stat,
        issueUpload,
        issueDownload,
        delete: deleteObject,
      })

      const recordActivity = Effect.fn(
        "InMemoryFileActivitySink.record",
      )(function* (event: FileActivity) {
        const shouldFail = yield* Ref.modify(activityState, (state) =>
          state.failNext
            ? [true, { ...state, failNext: false }] as const
            : [
                false,
                { ...state, events: [...state.events, event] },
              ] as const,
        )
        if (shouldFail) {
          return yield* Effect.fail(
            new FileActivityUnavailable({
              operation: "record",
              cause: new Error("in-memory activity failure requested by test"),
            }),
          )
        }
      })
      const activities = FileActivitySink.of({ record: recordActivity })

      const ids = FileIds.of({
        nextFileId: Ref.modify(identityState, (state) => [
          FileIdSchema.make(
            `file-${String(state.nextFile).padStart(6, "0")}`,
          ),
          { ...state, nextFile: state.nextFile + 1 },
        ] as const),
        nextActivityId: Ref.modify(identityState, (state) => [
          `activity-${String(state.nextActivity).padStart(6, "0")}`,
          { ...state, nextActivity: state.nextActivity + 1 },
        ] as const),
      })

      const controls = FileTestControl.of({
        putObject: Effect.fn("FileTestControl.putObject")(function* (input) {
          const locator = objectLocator(input.fileSystemId, input.fileId)
          yield* Ref.update(objectState, (state) => {
            const metadata = new Map(state.metadata)
            metadata.set(locator, {
              size: input.size,
              contentType: input.contentType,
              digest: input.digest,
            })
            return { ...state, metadata }
          })
        }),
        removeObject: Effect.fn("FileTestControl.removeObject")(function* (
          fileSystemId,
          fileId,
        ) {
          const locator = objectLocator(fileSystemId, fileId)
          yield* Ref.update(objectState, (state) => {
            const metadata = new Map(state.metadata)
            metadata.delete(locator)
            return { ...state, metadata }
          })
        }),
        objectExists: Effect.fn(
          "FileTestControl.objectExists",
        )(function* (fileSystemId, fileId) {
          const locator = objectLocator(fileSystemId, fileId)
          const state = yield* Ref.get(objectState)
          return state.metadata.has(locator)
        }),
        liveNodes: Effect.fn(
          "FileTestControl.liveNodes",
        )(function* (fileSystemId) {
          const state = yield* SynchronizedRef.get(catalogState)
          return liveRecords(state, fileSystemId)
            .map((record) => record.node)
            .sort(orderNodesByPath)
        }),
        deletedNodes: Effect.fn(
          "FileTestControl.deletedNodes",
        )(function* (fileSystemId) {
          const state = yield* SynchronizedRef.get(catalogState)
          const nodes: Array<StoredFileNode> = []
          for (const record of state.records.values()) {
            if (
              record.deletedAt !== null &&
              record.fileSystemId === fileSystemId
            ) {
              nodes.push(record.node)
            }
          }
          return nodes.sort(orderNodesByPath)
        }),
        reclaimedNodes: Effect.fn(
          "FileTestControl.reclaimedNodes",
        )(function* (fileSystemId) {
          const state = yield* SynchronizedRef.get(catalogState)
          const nodes: Array<StoredFileNode> = []
          for (const record of state.records.values()) {
            if (
              record.objectReclaimedAt !== null &&
              record.fileSystemId === fileSystemId
            ) {
              nodes.push(record.node)
            }
          }
          return nodes.sort(orderNodesByPath)
        }),
        activities: Effect.fn("FileTestControl.activities")(function* () {
          const state = yield* Ref.get(activityState)
          return [...state.events]
        }),
        issuedCapabilities: Effect.fn(
          "FileTestControl.issuedCapabilities",
        )(function* () {
          const state = yield* Ref.get(objectState)
          return [...state.capabilities]
        }),
        failNextActivity: Effect.fn(
          "FileTestControl.failNextActivity",
        )(function* () {
          yield* Ref.update(activityState, (state) => ({
            ...state,
            failNext: true,
          }))
        }),
        failNextObjectDelete: Effect.fn(
          "FileTestControl.failNextObjectDelete",
        )(function* () {
          yield* Ref.update(objectState, (state) => ({
            ...state,
            failNextDelete: true,
          }))
        }),
        objectDeleteAttempts: Effect.fn(
          "FileTestControl.objectDeleteAttempts",
        )(function* () {
          const state = yield* Ref.get(objectState)
          return [...state.deleteAttempts]
        }),
      })

      return Context.empty().pipe(
        Context.add(FileCatalog, catalog),
        Context.add(FileObjects, objects),
        Context.add(FileReclamationCatalog, reclamation),
        Context.add(FileActivitySink, activities),
        Context.add(FileIds, ids),
        Context.add(FileTestControl, controls),
      )
    }),
  )
