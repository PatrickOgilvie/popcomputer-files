import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm"
import { drizzle } from "drizzle-orm/sqlite-proxy"
import {
  Effect,
  Encoding,
  Layer,
  Option,
  Result,
  Schema,
} from "effect"
import {
  FileCatalog,
  FileObjectLocatorSchema,
  FileReclamationCatalog,
  StoredFileNodeSchema,
  type CatalogCreateFolderInput,
  type CatalogCreateFolderResult,
  type CatalogFilePage,
  type CatalogReserveUploadInput,
  type CatalogReserveUploadResult,
  type FileCatalogService,
  type FileReclamationCatalogService,
  type StoredFileNode,
} from "../adapter.js"
import {
  FileCatalogUnavailable,
  InvalidStoredFile,
} from "../errors.js"
import {
  ByteCountSchema,
  FileActorIdSchema,
  FileActorKindSchema,
  FileContentTypeSchema,
  FileIdSchema,
  FileNameSchema,
  FileSystemIdSchema,
  IdempotencyKeySchema,
  PageCursorSchema,
  RelativePathSchema,
  TimestampMillisSchema,
  childPath,
  replacePathLeaf,
  type FileId,
  type FileListTarget,
  type FileSystemId,
  type PageCursor,
  type RelativePath,
} from "../file.js"
import {
  d1FileFolderRequests,
  d1Files,
  d1FileUploadRequests,
  type D1FileFolderRequestRow,
  type D1FileRow,
  type D1FileUploadRequestRow,
} from "./d1-schema.js"

const D1FilesSqlValueSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Null,
])

/** SQL value emitted by this text-and-integer catalog schema. */
export type D1FilesSqlValue = Schema.Schema.Type<
  typeof D1FilesSqlValueSchema
>

/** One positional result row returned by a D1 prepared statement. */
export type D1FilesRawRow = ReadonlyArray<D1FilesSqlValue>

/** Structural D1 result used without leaking a platform binding into core code. */
export interface D1FilesResult<T = unknown> {
  readonly success: true
  readonly results: Array<T>
  readonly meta: { readonly changes: number } & Record<string, unknown>
  readonly error?: never
}

/** Prepared-statement surface structurally identical to Cloudflare D1. */
export interface D1FilesPreparedStatement {
  bind(...values: Array<unknown>): D1FilesPreparedStatement
  first<T = unknown>(colName: string): Promise<T | null>
  first<T = Record<string, unknown>>(): Promise<T | null>
  run<T = Record<string, unknown>>(): Promise<D1FilesResult<T>>
  all<T = Record<string, unknown>>(): Promise<D1FilesResult<T>>
  raw<T = unknown[]>(options: {
    readonly columnNames: true
  }): Promise<[string[], ...T[]]>
  raw<T = unknown[]>(options?: {
    readonly columnNames?: false
  }): Promise<T[]>
}

/** Transactional database surface structurally identical to Cloudflare D1. */
export interface D1FilesDatabase {
  prepare(query: string): D1FilesPreparedStatement
  batch<T = unknown>(
    statements: Array<D1FilesPreparedStatement>,
  ): Promise<Array<D1FilesResult<T>>>
}

const opaqueEtagSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
)
const sha256Schema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u),
)

const persistedLiveBase = {
  fileSystemId: FileSystemIdSchema,
  id: FileIdSchema,
  parentId: Schema.NullOr(FileIdSchema),
  name: FileNameSchema,
  path: RelativePathSchema,
  createdActorKind: FileActorKindSchema,
  createdActorId: FileActorIdSchema,
  updatedActorKind: FileActorKindSchema,
  updatedActorId: FileActorIdSchema,
  createdAt: TimestampMillisSchema,
  updatedAt: TimestampMillisSchema,
  deletedAt: Schema.Null,
  deletedActorKind: Schema.Null,
  deletedActorId: Schema.Null,
  reclaimAfter: Schema.Null,
  objectReclaimedAt: Schema.Null,
}

const PersistedFolderSchema = Schema.Struct({
  ...persistedLiveBase,
  kind: Schema.Literal("folder"),
  status: Schema.Literal("ready"),
  locator: Schema.Null,
  maximumBytes: Schema.Null,
  pendingExpiresAt: Schema.Null,
  size: Schema.Null,
  contentType: Schema.Null,
  digestKind: Schema.Null,
  digestValue: Schema.Null,
})

const PersistedPendingFileSchema = Schema.Struct({
  ...persistedLiveBase,
  kind: Schema.Literal("file"),
  status: Schema.Literal("pending"),
  locator: FileObjectLocatorSchema,
  maximumBytes: ByteCountSchema,
  pendingExpiresAt: TimestampMillisSchema,
  size: Schema.Null,
  contentType: Schema.Null,
  digestKind: Schema.Null,
  digestValue: Schema.Null,
})

const readyFileBase = {
  ...persistedLiveBase,
  kind: Schema.Literal("file"),
  status: Schema.Literal("ready"),
  locator: FileObjectLocatorSchema,
  maximumBytes: ByteCountSchema,
  pendingExpiresAt: Schema.Null,
  size: ByteCountSchema,
  contentType: Schema.NullOr(FileContentTypeSchema),
}

const PersistedReadyFileWithoutDigestSchema = Schema.Struct({
  ...readyFileBase,
  digestKind: Schema.Null,
  digestValue: Schema.Null,
})
const PersistedReadyFileWithSha256Schema = Schema.Struct({
  ...readyFileBase,
  digestKind: Schema.Literal("sha256"),
  digestValue: sha256Schema,
})
const PersistedReadyFileWithOpaqueEtagSchema = Schema.Struct({
  ...readyFileBase,
  digestKind: Schema.Literal("opaque_etag"),
  digestValue: opaqueEtagSchema,
})

const PersistedLiveFileRowSchema = Schema.Union([
  PersistedFolderSchema,
  PersistedPendingFileSchema,
  PersistedReadyFileWithoutDigestSchema,
  PersistedReadyFileWithSha256Schema,
  PersistedReadyFileWithOpaqueEtagSchema,
])
type PersistedLiveFileRow = Schema.Schema.Type<
  typeof PersistedLiveFileRowSchema
>

const PersistedFolderRequestSchema = Schema.Struct({
  fileSystemId: FileSystemIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  fileId: FileIdSchema,
  requestedParentId: Schema.NullOr(FileIdSchema),
  requestedName: FileNameSchema,
  createdAt: TimestampMillisSchema,
})
type PersistedFolderRequest = Schema.Schema.Type<
  typeof PersistedFolderRequestSchema
>

const PersistedUploadRequestSchema = Schema.Struct({
  fileSystemId: FileSystemIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  fileId: FileIdSchema,
  requestedParentId: Schema.NullOr(FileIdSchema),
  requestedName: FileNameSchema,
  requestedMaximumBytes: ByteCountSchema,
  createdAt: TimestampMillisSchema,
})
type PersistedUploadRequest = Schema.Schema.Type<
  typeof PersistedUploadRequestSchema
>

const ReplayStateSchema = Schema.Struct({
  fileSystemId: FileSystemIdSchema,
  id: FileIdSchema,
  kind: Schema.Literals(["folder", "file"]),
  status: Schema.Literals(["pending", "ready"]),
  deletedAt: Schema.NullOr(TimestampMillisSchema),
})

const ReturningFileRowSchema = Schema.Tuple([
  FileSystemIdSchema,
  FileIdSchema,
  Schema.NullOr(FileIdSchema),
  Schema.Literals(["folder", "file"]),
  Schema.Literals(["pending", "ready"]),
  FileNameSchema,
  RelativePathSchema,
  Schema.NullOr(FileObjectLocatorSchema),
  Schema.NullOr(ByteCountSchema),
  Schema.NullOr(TimestampMillisSchema),
  Schema.NullOr(ByteCountSchema),
  Schema.NullOr(FileContentTypeSchema),
  Schema.NullOr(Schema.Literals(["sha256", "opaque_etag"])),
  Schema.NullOr(Schema.String),
  FileActorKindSchema,
  FileActorIdSchema,
  FileActorKindSchema,
  FileActorIdSchema,
  TimestampMillisSchema,
  TimestampMillisSchema,
  Schema.Null,
  Schema.Null,
  Schema.Null,
  Schema.Null,
  Schema.Null,
])

const ReclamationCandidateRowsSchema = Schema.Array(
  Schema.Tuple([
    FileSystemIdSchema,
    FileIdSchema,
    FileObjectLocatorSchema,
  ]),
)
const RawRowsSchema = Schema.Array(Schema.Array(D1FilesSqlValueSchema))
const BindValuesSchema = Schema.Array(D1FilesSqlValueSchema)
const ChangedRowsSchema = Schema.Struct({
  meta: Schema.Struct({
    changes: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
    ),
  }),
})
const IdentityRowSchema = Schema.Struct({ id: FileIdSchema })
const CursorPayloadSchema = Schema.Struct({
  version: Schema.Literal(1),
  fileSystemId: FileSystemIdSchema,
  parentId: Schema.NullOr(FileIdSchema),
  kind: Schema.Literals(["folder", "file"]),
  name: FileNameSchema,
  id: FileIdSchema,
})
type CursorPayload = Schema.Schema.Type<typeof CursorPayloadSchema>
const CursorPayloadFromStringSchema = Schema.fromJsonString(
  CursorPayloadSchema,
)

const returningColumns = `
  file_system_id,
  id,
  parent_id,
  kind,
  status,
  name,
  path,
  locator,
  maximum_bytes,
  pending_expires_at,
  size,
  content_type,
  digest_kind,
  digest_value,
  created_actor_kind,
  created_actor_id,
  updated_actor_kind,
  updated_actor_id,
  created_at,
  updated_at,
  deleted_at,
  deleted_actor_kind,
  deleted_actor_id,
  reclaim_after,
  object_reclaimed_at
`

const insertNodeSql = `
  INSERT INTO popcomputer_files (${returningColumns})
  SELECT
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE ? IS NULL OR EXISTS (
    SELECT 1
    FROM popcomputer_files AS parent
    WHERE parent.file_system_id = ?
      AND parent.id = ?
      AND parent.deleted_at IS NULL
      AND parent.kind = 'folder'
  )
  ON CONFLICT DO NOTHING
  RETURNING ${returningColumns}
`

const insertCommandNodeSql = `
  INSERT INTO popcomputer_files (${returningColumns})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

const insertFolderRequestSql = `
  INSERT INTO popcomputer_file_folder_requests (
    file_system_id,
    idempotency_key,
    file_id,
    requested_parent_id,
    requested_name,
    created_at
  ) VALUES (?, ?, ?, ?, ?, ?)
`

const insertUploadRequestSql = `
  INSERT INTO popcomputer_file_upload_requests (
    file_system_id,
    idempotency_key,
    file_id,
    requested_parent_id,
    requested_name,
    requested_maximum_bytes,
    created_at
  )
  SELECT ?, ?, ?, ?, ?, ?, ?
  WHERE EXISTS (
    SELECT 1
    FROM popcomputer_files AS file
    WHERE file.file_system_id = ?
      AND file.id = ?
      AND file.locator = ?
      AND file.kind = 'file'
      AND file.status = 'pending'
      AND file.deleted_at IS NULL
  )
`

const extendPendingExpirySql = `
  UPDATE popcomputer_files
  SET pending_expires_at = CASE
    WHEN pending_expires_at < ? THEN ?
    ELSE pending_expires_at
  END
  WHERE file_system_id = ?
    AND id = ?
    AND deleted_at IS NULL
    AND kind = 'file'
    AND status = 'pending'
  RETURNING ${returningColumns}
`

const confirmUploadSql = `
  UPDATE popcomputer_files
  SET status = 'ready',
      pending_expires_at = NULL,
      size = ?,
      content_type = ?,
      digest_kind = ?,
      digest_value = ?,
      updated_actor_kind = ?,
      updated_actor_id = ?,
      updated_at = ?
  WHERE file_system_id = ?
    AND id = ?
    AND deleted_at IS NULL
    AND kind = 'file'
    AND status = 'pending'
    AND ? <= maximum_bytes
    AND COALESCE((
      SELECT SUM(ready.size)
      FROM popcomputer_files AS ready
      WHERE ready.file_system_id = ?
        AND ready.deleted_at IS NULL
        AND ready.kind = 'file'
        AND ready.status = 'ready'
    ), 0) + ? <= ?
  RETURNING ${returningColumns}
`

const renameFileSql = `
  UPDATE popcomputer_files
  SET name = ?,
      path = ?,
      updated_actor_kind = ?,
      updated_actor_id = ?,
      updated_at = ?
  WHERE file_system_id = ?
    AND id = ?
    AND deleted_at IS NULL
    AND kind = 'file'
    AND NOT EXISTS (
      SELECT 1
      FROM popcomputer_files AS conflict
      WHERE conflict.file_system_id = ?
        AND conflict.deleted_at IS NULL
        AND conflict.id <> ?
        AND (
          conflict.path = ?
          OR (
            conflict.parent_id IS popcomputer_files.parent_id
            AND conflict.name = ?
          )
        )
    )
  RETURNING ${returningColumns}
`

const softDeleteSubtreeSql = `
  UPDATE popcomputer_files
  SET deleted_at = ?,
      deleted_actor_kind = ?,
      deleted_actor_id = ?,
      updated_at = ?,
      updated_actor_kind = ?,
      updated_actor_id = ?,
      reclaim_after = CASE
        WHEN pending_expires_at IS NOT NULL AND pending_expires_at > ?
          THEN pending_expires_at
        ELSE ?
      END
  WHERE file_system_id = ?
    AND deleted_at IS NULL
    AND (path = ? OR substr(path, 1, length(?)) = ?)
`

const expirePendingBatchSql = `
  UPDATE popcomputer_files
  SET deleted_at = ?,
      deleted_actor_kind = ?,
      deleted_actor_id = ?,
      updated_at = ?,
      updated_actor_kind = ?,
      updated_actor_id = ?,
      reclaim_after = CASE
        WHEN pending_expires_at > ? THEN pending_expires_at
        ELSE ?
      END
  WHERE (file_system_id, id) IN (
    SELECT file_system_id, id
    FROM popcomputer_files
    WHERE deleted_at IS NULL
      AND kind = 'file'
      AND status = 'pending'
      AND pending_expires_at <= ?
    ORDER BY pending_expires_at, file_system_id, id
    LIMIT ?
  )
`

const listReclaimableSql = `
  SELECT file_system_id, id, locator
  FROM popcomputer_files
  WHERE deleted_at IS NOT NULL
    AND locator IS NOT NULL
    AND object_reclaimed_at IS NULL
    AND reclaim_after <= ?
  ORDER BY reclaim_after, file_system_id, id
  LIMIT ?
`

const completeReclamationSql = `
  UPDATE popcomputer_files
  SET object_reclaimed_at = ?
  WHERE file_system_id = ?
    AND id = ?
    AND locator = ?
    AND deleted_at IS NOT NULL
    AND object_reclaimed_at IS NULL
    AND reclaim_after <= ?
`

const deferReclamationSql = `
  UPDATE popcomputer_files
  SET reclaim_after = CASE
    WHEN reclaim_after < ? THEN ?
    ELSE reclaim_after
  END
  WHERE file_system_id = ?
    AND id = ?
    AND locator = ?
    AND deleted_at IS NOT NULL
    AND object_reclaimed_at IS NULL
`

const purgeReclaimedBatchSql = `
  DELETE FROM popcomputer_files
  WHERE (file_system_id, id) IN (
    SELECT candidate.file_system_id, candidate.id
    FROM popcomputer_files AS candidate
    WHERE candidate.deleted_at IS NOT NULL
      AND candidate.deleted_at <= ?
      AND (
        candidate.locator IS NULL
        OR candidate.object_reclaimed_at IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM popcomputer_files AS child
        WHERE child.file_system_id = candidate.file_system_id
          AND child.parent_id = candidate.id
      )
    ORDER BY length(candidate.path) DESC, candidate.file_system_id, candidate.id
    LIMIT ?
  )
`

const unavailable = (
  operation: string,
  cause: unknown,
): FileCatalogUnavailable =>
  new FileCatalogUnavailable({ operation, cause })

const invalidStoredRow = (): InvalidStoredFile =>
  new InvalidStoredFile({
    reason: "stored file row violated the catalog schema",
  })

const attempt = <A>(
  operation: string,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, FileCatalogUnavailable> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => unavailable(operation, cause),
  })

const decodePersistedRow = (
  input: D1FileRow,
): Effect.Effect<PersistedLiveFileRow, InvalidStoredFile> =>
  Schema.decodeUnknownEffect(PersistedLiveFileRowSchema)(input).pipe(
    Effect.mapError(invalidStoredRow),
  )

const decodeFolderRequest = (
  input: D1FileFolderRequestRow,
): Effect.Effect<PersistedFolderRequest, InvalidStoredFile> =>
  Schema.decodeUnknownEffect(PersistedFolderRequestSchema)(input).pipe(
    Effect.mapError(invalidStoredRow),
  )

const decodeUploadRequest = (
  input: D1FileUploadRequestRow,
): Effect.Effect<PersistedUploadRequest, InvalidStoredFile> =>
  Schema.decodeUnknownEffect(PersistedUploadRequestSchema)(input).pipe(
    Effect.mapError(invalidStoredRow),
  )

const toStoredNode = (
  row: PersistedLiveFileRow,
): Effect.Effect<StoredFileNode, InvalidStoredFile> => {
  const base = {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    path: row.path,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  const candidate: unknown =
    row.kind === "folder"
      ? { _tag: "Folder", ...base }
      : row.status === "pending"
        ? {
            _tag: "PendingFile",
            ...base,
            locator: row.locator,
            maximumBytes: row.maximumBytes,
            pendingExpiresAt: row.pendingExpiresAt,
          }
        : {
            _tag: "ReadyFile",
            ...base,
            locator: row.locator,
            maximumBytes: row.maximumBytes,
            size: row.size,
            contentType: row.contentType,
            digest:
              row.digestKind === null
                ? null
                : row.digestKind === "sha256"
                  ? { _tag: "Sha256", value: row.digestValue }
                  : { _tag: "OpaqueEtag", value: row.digestValue },
          }
  return Schema.decodeUnknownEffect(StoredFileNodeSchema)(candidate).pipe(
    Effect.mapError(invalidStoredRow),
  )
}

const decodeNode = (
  input: D1FileRow,
): Effect.Effect<StoredFileNode, InvalidStoredFile> =>
  decodePersistedRow(input).pipe(Effect.flatMap(toStoredNode))

const decodeReturningRow = (
  input: D1FilesRawRow,
): Effect.Effect<StoredFileNode, InvalidStoredFile> =>
  Schema.decodeUnknownEffect(ReturningFileRowSchema)(input).pipe(
    Effect.mapError(invalidStoredRow),
    Effect.flatMap((row) =>
      decodePersistedRow({
        fileSystemId: row[0],
        id: row[1],
        parentId: row[2],
        kind: row[3],
        status: row[4],
        name: row[5],
        path: row[6],
        locator: row[7],
        maximumBytes: row[8],
        pendingExpiresAt: row[9],
        size: row[10],
        contentType: row[11],
        digestKind: row[12],
        digestValue: row[13],
        createdActorKind: row[14],
        createdActorId: row[15],
        updatedActorKind: row[16],
        updatedActorId: row[17],
        createdAt: row[18],
        updatedAt: row[19],
        deletedAt: row[20],
        deletedActorKind: row[21],
        deletedActorId: row[22],
        reclaimAfter: row[23],
        objectReclaimedAt: row[24],
      }),
    ),
    Effect.flatMap(toStoredNode),
  )

const encodeCursor = (
  fileSystemId: FileSystemId,
  parentId: FileId | null,
  node: StoredFileNode,
): PageCursor =>
  PageCursorSchema.make(
    Encoding.encodeBase64Url(
      JSON.stringify({
        version: 1,
        fileSystemId,
        parentId,
        kind: node._tag === "Folder" ? "folder" : "file",
        name: node.name,
        id: node.id,
      }),
    ),
  )

const decodeCursor = (cursor: PageCursor): CursorPayload | null => {
  const text = Result.getOrNull(Encoding.decodeBase64UrlString(cursor))
  if (text === null) return null
  return Option.getOrNull(
    Schema.decodeUnknownOption(CursorPayloadFromStringSchema)(text),
  )
}

interface D1Adapters {
  readonly catalog: FileCatalogService
  readonly reclamation: FileReclamationCatalogService
}

const makeD1Adapters = (database: D1FilesDatabase): D1Adapters => {
  const drizzleDatabase = drizzle(
    async (
      query: string,
      params: Array<unknown>,
      method: "run" | "all" | "values" | "get",
    ) => {
      const values = await Schema.decodeUnknownPromise(BindValuesSchema)(params)
      const statement = database.prepare(query).bind(...values)
      if (method === "run") {
        await statement.run()
        return { rows: [] }
      }
      const rows = await Schema.decodeUnknownPromise(RawRowsSchema)(
        await statement.raw(),
      )
      if (method === "get") {
        const first = rows[0]
        return { rows: first === undefined ? [] : [...first] }
      }
      return { rows: rows.map((row) => [...row]) }
    },
    { schema: { d1Files, d1FileFolderRequests, d1FileUploadRequests } },
  )

  const livePredicate = (fileSystemId: FileSystemId): SQL<unknown> =>
    sql`${d1Files.fileSystemId} = ${fileSystemId}
      AND ${d1Files.deletedAt} IS NULL`

  const directParentPredicate = (parentId: FileId | null): SQL<unknown> =>
    parentId === null
      ? isNull(d1Files.parentId)
      : eq(d1Files.parentId, parentId)

  const selectLiveById = (
    fileSystemId: FileSystemId,
    fileId: FileId,
  ): Effect.Effect<
    StoredFileNode | null,
    FileCatalogUnavailable | InvalidStoredFile
  > =>
    Effect.gen(function* () {
      const rows = yield* attempt("get_file", () =>
        drizzleDatabase
          .select()
          .from(d1Files)
          .where(and(livePredicate(fileSystemId), eq(d1Files.id, fileId)))
          .limit(1),
      )
      const row = rows[0]
      return row === undefined ? null : yield* decodeNode(row)
    })

  const selectAnyRowById = (
    fileSystemId: FileSystemId,
    fileId: FileId,
  ): Effect.Effect<D1FileRow | null, FileCatalogUnavailable> =>
    attempt("get_file_replay_state", () =>
      drizzleDatabase
        .select()
        .from(d1Files)
        .where(
          and(
            eq(d1Files.fileSystemId, fileSystemId),
            eq(d1Files.id, fileId),
          ),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0] ?? null))

  const selectLiveByPath = (
    fileSystemId: FileSystemId,
    path: RelativePath,
  ): Effect.Effect<
    StoredFileNode | null,
    FileCatalogUnavailable | InvalidStoredFile
  > =>
    Effect.gen(function* () {
      const rows = yield* attempt("get_file_by_path", () =>
        drizzleDatabase
          .select()
          .from(d1Files)
          .where(and(livePredicate(fileSystemId), eq(d1Files.path, path)))
          .limit(1),
      )
      const row = rows[0]
      return row === undefined ? null : yield* decodeNode(row)
    })

  const selectUploadRequest = (
    fileSystemId: FileSystemId,
    idempotencyKey: CatalogReserveUploadInput["idempotencyKey"],
  ): Effect.Effect<
    PersistedUploadRequest | null,
    FileCatalogUnavailable | InvalidStoredFile
  > =>
    Effect.gen(function* () {
      const rows = yield* attempt("get_upload_request", () =>
        drizzleDatabase
          .select()
          .from(d1FileUploadRequests)
          .where(
            and(
              eq(d1FileUploadRequests.fileSystemId, fileSystemId),
              eq(d1FileUploadRequests.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1),
      )
      const row = rows[0]
      return row === undefined ? null : yield* decodeUploadRequest(row)
    })

  const selectFolderRequest = (
    fileSystemId: FileSystemId,
    idempotencyKey: CatalogCreateFolderInput["idempotencyKey"],
  ): Effect.Effect<
    PersistedFolderRequest | null,
    FileCatalogUnavailable | InvalidStoredFile
  > =>
    Effect.gen(function* () {
      const rows = yield* attempt("get_folder_request", () =>
        drizzleDatabase
          .select()
          .from(d1FileFolderRequests)
          .where(
            and(
              eq(d1FileFolderRequests.fileSystemId, fileSystemId),
              eq(d1FileFolderRequests.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1),
      )
      const row = rows[0]
      return row === undefined ? null : yield* decodeFolderRequest(row)
    })

  const identityExists = (
    fileSystemId: FileSystemId,
    fileId: FileId,
  ): Effect.Effect<
    boolean,
    FileCatalogUnavailable | InvalidStoredFile
  > =>
    Effect.gen(function* () {
      const rows = yield* attempt("check_file_identity", () =>
        drizzleDatabase
          .select({ id: d1Files.id })
          .from(d1Files)
          .where(
            and(
              eq(d1Files.fileSystemId, fileSystemId),
              eq(d1Files.id, fileId),
            ),
          )
          .limit(1),
      )
      const row = rows[0]
      if (row === undefined) return false
      yield* Schema.decodeUnknownEffect(IdentityRowSchema)(row).pipe(
        Effect.mapError(invalidStoredRow),
      )
      return true
    })

  type ParentResolution =
    | { readonly _tag: "Parent"; readonly path: RelativePath | null }
    | { readonly _tag: "ParentNotFound" }
    | { readonly _tag: "ParentNotFolder"; readonly parentId: FileId }

  const resolveParent = (
    fileSystemId: FileSystemId,
    parentId: FileId | null,
  ): Effect.Effect<
    ParentResolution,
    FileCatalogUnavailable | InvalidStoredFile
  > =>
    Effect.gen(function* () {
      if (parentId === null) return { _tag: "Parent", path: null }
      const node = yield* selectLiveById(fileSystemId, parentId)
      if (node === null) return { _tag: "ParentNotFound" }
      if (node._tag !== "Folder") {
        return { _tag: "ParentNotFolder", parentId }
      }
      return { _tag: "Parent", path: node.path }
    })

  type ListParentResolution =
    | { readonly _tag: "Parent"; readonly parentId: FileId | null }
    | { readonly _tag: "TargetNotFound" }
    | { readonly _tag: "TargetNotFolder"; readonly fileId: FileId }

  const resolveListParent = (
    fileSystemId: FileSystemId,
    target: FileListTarget,
  ): Effect.Effect<
    ListParentResolution,
    FileCatalogUnavailable | InvalidStoredFile
  > =>
    Effect.gen(function* () {
      if (target._tag === "Root") return { _tag: "Parent", parentId: null }
      const node =
        target._tag === "FolderId"
          ? yield* selectLiveById(fileSystemId, target.id)
          : yield* selectLiveByPath(fileSystemId, target.path)
      if (node === null) return { _tag: "TargetNotFound" }
      if (node._tag !== "Folder") {
        return { _tag: "TargetNotFolder", fileId: node.id }
      }
      return { _tag: "Parent", parentId: node.id }
    })

  const hasLiveSibling = (
    fileSystemId: FileSystemId,
    parentId: FileId | null,
    name: string,
    exceptId: FileId | null,
  ): Effect.Effect<boolean, FileCatalogUnavailable | InvalidStoredFile> =>
    Effect.gen(function* () {
      const exceptPredicate =
        exceptId === null ? undefined : ne(d1Files.id, exceptId)
      const rows = yield* attempt("check_file_name", () =>
        drizzleDatabase
          .select({ id: d1Files.id })
          .from(d1Files)
          .where(
            and(
              livePredicate(fileSystemId),
              directParentPredicate(parentId),
              eq(d1Files.name, name),
              exceptPredicate,
            ),
          )
          .limit(1),
      )
      const row = rows[0]
      if (row === undefined) return false
      yield* Schema.decodeUnknownEffect(IdentityRowSchema)(row).pipe(
        Effect.mapError(invalidStoredRow),
      )
      return true
    })

  const runReturning = (
    operation: string,
    query: string,
    values: Array<D1FilesSqlValue>,
  ): Effect.Effect<
    StoredFileNode | null,
    FileCatalogUnavailable | InvalidStoredFile
  > =>
    Effect.gen(function* () {
      const raw = yield* attempt(operation, () =>
        database.prepare(query).bind(...values).raw(),
      )
      const rows = yield* Schema.decodeUnknownEffect(RawRowsSchema)(raw).pipe(
        Effect.mapError(invalidStoredRow),
      )
      const first = rows[0]
      return first === undefined ? null : yield* decodeReturningRow(first)
    })

  const sameFolderFingerprint = (
    request: PersistedFolderRequest,
    input: CatalogCreateFolderInput,
  ): boolean =>
    request.requestedParentId === input.parentId &&
    request.requestedName === input.name

  const folderReplayResult = (
    request: PersistedFolderRequest,
    input: CatalogCreateFolderInput,
  ): Effect.Effect<
    CatalogCreateFolderResult,
    FileCatalogUnavailable | InvalidStoredFile
  > =>
    Effect.gen(function* () {
      if (!sameFolderFingerprint(request, input)) {
        return { _tag: "IdempotencyConflict" }
      }
      const row = yield* selectAnyRowById(input.fileSystemId, request.fileId)
      if (row === null) {
        return { _tag: "ReplayUnavailable", fileId: request.fileId }
      }
      const state = yield* Schema.decodeUnknownEffect(ReplayStateSchema)({
        fileSystemId: row.fileSystemId,
        id: row.id,
        kind: row.kind,
        status: row.status,
        deletedAt: row.deletedAt,
      }).pipe(Effect.mapError(invalidStoredRow))
      if (state.kind !== "folder") return yield* Effect.fail(invalidStoredRow())
      if (state.deletedAt !== null) {
        return { _tag: "ReplayUnavailable", fileId: request.fileId }
      }
      const node = yield* decodeNode(row)
      if (node._tag !== "Folder") return yield* Effect.fail(invalidStoredRow())
      return { _tag: "ReplayFolder", node }
    })

  const sameReservationFingerprint = (
    request: PersistedUploadRequest,
    input: CatalogReserveUploadInput,
  ): boolean =>
    request.requestedParentId === input.parentId &&
    request.requestedName === input.name &&
    request.requestedMaximumBytes === input.maximumBytes

  const replayResult = (
    request: PersistedUploadRequest,
    input: CatalogReserveUploadInput,
  ): Effect.Effect<
    CatalogReserveUploadResult,
    FileCatalogUnavailable | InvalidStoredFile
  > =>
    Effect.gen(function* () {
      if (!sameReservationFingerprint(request, input)) {
        return { _tag: "IdempotencyConflict" }
      }
      const row = yield* selectAnyRowById(input.fileSystemId, request.fileId)
      if (row === null) {
        return { _tag: "ReplayUnavailable", fileId: request.fileId }
      }
      const state = yield* Schema.decodeUnknownEffect(ReplayStateSchema)({
        fileSystemId: row.fileSystemId,
        id: row.id,
        kind: row.kind,
        status: row.status,
        deletedAt: row.deletedAt,
      }).pipe(Effect.mapError(invalidStoredRow))
      if (state.kind !== "file") return yield* Effect.fail(invalidStoredRow())
      if (state.deletedAt !== null) {
        return { _tag: "ReplayUnavailable", fileId: request.fileId }
      }
      if (state.status === "ready") {
        const node = yield* decodeNode(row)
        if (node._tag !== "ReadyFile") {
          return yield* Effect.fail(invalidStoredRow())
        }
        return { _tag: "ReplayReady", node }
      }

      const extended = yield* runReturning(
        "extend_pending_upload",
        extendPendingExpirySql,
        [
          input.pendingExpiresAt,
          input.pendingExpiresAt,
          input.fileSystemId,
          request.fileId,
        ],
      )
      if (extended?._tag === "PendingFile") {
        return { _tag: "ReplayPending", node: extended }
      }
      if (extended !== null) return yield* Effect.fail(invalidStoredRow())

      const afterRace = yield* selectAnyRowById(
        input.fileSystemId,
        request.fileId,
      )
      if (afterRace === null || afterRace.deletedAt !== null) {
        return { _tag: "ReplayUnavailable", fileId: request.fileId }
      }
      const afterNode = yield* decodeNode(afterRace)
      if (afterNode._tag === "ReadyFile") {
        return { _tag: "ReplayReady", node: afterNode }
      }
      return yield* Effect.fail(
        unavailable(
          "extend_pending_upload",
          new Error("D1 did not classify the rejected pending replay."),
        ),
      )
    })

  const get: FileCatalogService["get"] = Effect.fn(
    "D1FileCatalog.get",
  )(function* (fileSystemId, fileId) {
    return yield* selectLiveById(fileSystemId, fileId)
  })

  const listChildren: FileCatalogService["listChildren"] = Effect.fn(
    "D1FileCatalog.listChildren",
  )(function* (fileSystemId, target, page) {
    const parent = yield* resolveListParent(fileSystemId, target)
    if (parent._tag !== "Parent") return parent

    const cursor = page.cursor === null ? null : decodeCursor(page.cursor)
    if (
      page.cursor !== null &&
      (cursor === null ||
        cursor.fileSystemId !== fileSystemId ||
        cursor.parentId !== parent.parentId)
    ) {
      return { _tag: "InvalidCursor" }
    }

    const afterCursor =
      cursor === null
        ? undefined
        : cursor.kind === "folder"
          ? or(
              eq(d1Files.kind, "file"),
              and(
                eq(d1Files.kind, "folder"),
                or(
                  gt(d1Files.name, cursor.name),
                  and(
                    eq(d1Files.name, cursor.name),
                    gt(d1Files.id, cursor.id),
                  ),
                ),
              ),
            )
          : and(
              eq(d1Files.kind, "file"),
              or(
                gt(d1Files.name, cursor.name),
                and(
                  eq(d1Files.name, cursor.name),
                  gt(d1Files.id, cursor.id),
                ),
              ),
            )

    const rows = yield* attempt("list_children", () =>
      drizzleDatabase
        .select()
        .from(d1Files)
        .where(
          and(
            livePredicate(fileSystemId),
            directParentPredicate(parent.parentId),
            afterCursor,
          ),
        )
        .orderBy(
          desc(d1Files.kind),
          asc(d1Files.name),
          asc(d1Files.id),
        )
        .limit(page.size + 1),
    )
    const decoded = yield* Effect.forEach(rows, decodeNode)
    const items = decoded.slice(0, page.size)
    const last = items.at(-1)
    const nextCursor =
      decoded.length > page.size && last !== undefined
        ? encodeCursor(fileSystemId, parent.parentId, last)
        : null
    const resultPage: CatalogFilePage = { items, cursor: nextCursor }
    return { _tag: "Page", page: resultPage }
  })

  const createFolder: FileCatalogService["createFolder"] = Effect.fn(
    "D1FileCatalog.createFolder",
  )(function* (input) {
    const existing = yield* selectFolderRequest(
      input.fileSystemId,
      input.idempotencyKey,
    )
    if (existing !== null) return yield* folderReplayResult(existing, input)

    const parent = yield* resolveParent(input.fileSystemId, input.parentId)
    if (parent._tag !== "Parent") return parent
    const maybePath = yield* Effect.option(childPath(parent.path, input.name))
    if (Option.isNone(maybePath)) return { _tag: "InvalidPath" }

    const nodeValues: Array<D1FilesSqlValue> = [
      input.fileSystemId,
      input.id,
      input.parentId,
      "folder",
      "ready",
      input.name,
      maybePath.value,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      input.actor.kind,
      input.actor.id,
      input.actor.kind,
      input.actor.id,
      input.now,
      input.now,
      null,
      null,
      null,
      null,
      null,
    ]
    const nodeStatement = database
      .prepare(insertCommandNodeSql)
      .bind(...nodeValues)
    const ledgerStatement = database.prepare(insertFolderRequestSql).bind(
      input.fileSystemId,
      input.idempotencyKey,
      input.id,
      input.parentId,
      input.name,
      input.now,
    )
    const batchOutcome = yield* Effect.result(
      attempt("create_folder", () =>
        database.batch([nodeStatement, ledgerStatement]),
      ),
    )

    const recorded = yield* selectFolderRequest(
      input.fileSystemId,
      input.idempotencyKey,
    )
    if (recorded !== null) {
      if (
        recorded.fileId === input.id &&
        sameFolderFingerprint(recorded, input)
      ) {
        const inserted = yield* selectLiveById(input.fileSystemId, input.id)
        if (inserted?._tag === "Folder") {
          return { _tag: "Created", node: inserted }
        }
      }
      return yield* folderReplayResult(recorded, input)
    }

    if (yield* identityExists(input.fileSystemId, input.id)) {
      return yield* Effect.fail(
        new InvalidStoredFile({
          reason: "file identity already exists in this filesystem",
        }),
      )
    }
    const currentParent = yield* resolveParent(
      input.fileSystemId,
      input.parentId,
    )
    if (currentParent._tag !== "Parent") return currentParent
    if (
      yield* hasLiveSibling(
        input.fileSystemId,
        input.parentId,
        input.name,
        null,
      )
    ) {
      return { _tag: "NameConflict" }
    }
    if (Result.isFailure(batchOutcome)) {
      return yield* Effect.fail(batchOutcome.failure)
    }
    return yield* Effect.fail(
      unavailable(
        "create_folder",
        new Error("D1 did not classify the rejected folder insert."),
      ),
    )
  })

  const reserveUpload: FileCatalogService["reserveUpload"] = Effect.fn(
    "D1FileCatalog.reserveUpload",
  )(function* (input) {
    const existing = yield* selectUploadRequest(
      input.fileSystemId,
      input.idempotencyKey,
    )
    if (existing !== null) return yield* replayResult(existing, input)

    const parent = yield* resolveParent(input.fileSystemId, input.parentId)
    if (parent._tag !== "Parent") return parent
    const maybePath = yield* Effect.option(childPath(parent.path, input.name))
    if (Option.isNone(maybePath)) return { _tag: "InvalidPath" }

    const nodeValues: Array<D1FilesSqlValue> = [
      input.fileSystemId,
      input.id,
      input.parentId,
      "file",
      "pending",
      input.name,
      maybePath.value,
      input.locator,
      input.maximumBytes,
      input.pendingExpiresAt,
      null,
      null,
      null,
      null,
      input.actor.kind,
      input.actor.id,
      input.actor.kind,
      input.actor.id,
      input.now,
      input.now,
      null,
      null,
      null,
      null,
      null,
    ]
    const nodeStatement = database.prepare(insertNodeSql).bind(
      ...nodeValues,
      input.parentId,
      input.fileSystemId,
      input.parentId,
    )
    const ledgerStatement = database.prepare(insertUploadRequestSql).bind(
      input.fileSystemId,
      input.idempotencyKey,
      input.id,
      input.parentId,
      input.name,
      input.maximumBytes,
      input.now,
      input.fileSystemId,
      input.id,
      input.locator,
    )
    const batchOutcome = yield* Effect.result(
      attempt("reserve_upload", () =>
        database.batch([nodeStatement, ledgerStatement]),
      ),
    )

    const recorded = yield* selectUploadRequest(
      input.fileSystemId,
      input.idempotencyKey,
    )
    if (recorded !== null) {
      if (recorded.fileId === input.id) {
        const inserted = yield* selectLiveById(input.fileSystemId, input.id)
        if (inserted?._tag === "PendingFile") {
          return { _tag: "Created", node: inserted }
        }
      }
      return yield* replayResult(recorded, input)
    }

    if (yield* identityExists(input.fileSystemId, input.id)) {
      return yield* Effect.fail(
        new InvalidStoredFile({
          reason: "file identity already exists in this filesystem",
        }),
      )
    }
    const currentParent = yield* resolveParent(
      input.fileSystemId,
      input.parentId,
    )
    if (currentParent._tag !== "Parent") return currentParent
    if (
      yield* hasLiveSibling(
        input.fileSystemId,
        input.parentId,
        input.name,
        null,
      )
    ) {
      return { _tag: "NameConflict" }
    }
    if (Result.isFailure(batchOutcome)) {
      return yield* Effect.fail(batchOutcome.failure)
    }
    return yield* Effect.fail(
      unavailable(
        "reserve_upload",
        new Error("D1 did not classify the rejected upload reservation."),
      ),
    )
  })

  const confirmUpload: FileCatalogService["confirmUpload"] = Effect.fn(
    "D1FileCatalog.confirmUpload",
  )(function* (input) {
    const digestKind =
      input.digest === null
        ? null
        : input.digest._tag === "Sha256"
          ? "sha256"
          : "opaque_etag"
    const updated = yield* runReturning(
      "confirm_upload",
      confirmUploadSql,
      [
        input.size,
        input.contentType,
        digestKind,
        input.digest?.value ?? null,
        input.actor.kind,
        input.actor.id,
        input.now,
        input.fileSystemId,
        input.fileId,
        input.size,
        input.fileSystemId,
        input.size,
        input.quotaBytes,
      ],
    )
    if (updated?._tag === "ReadyFile") {
      return { _tag: "Confirmed", node: updated }
    }
    if (updated !== null) return yield* Effect.fail(invalidStoredRow())

    const current = yield* selectLiveById(input.fileSystemId, input.fileId)
    if (current === null || current._tag === "Folder") {
      return { _tag: "NotFound" }
    }
    if (current._tag === "ReadyFile") {
      return { _tag: "AlreadyReady", node: current }
    }
    if (input.size > current.maximumBytes) {
      return yield* Effect.fail(
        new InvalidStoredFile({
          reason: "confirmed size exceeds the reserved upload bound",
        }),
      )
    }
    return { _tag: "QuotaExceeded" }
  })

  const renameFile: FileCatalogService["renameFile"] = Effect.fn(
    "D1FileCatalog.renameFile",
  )(function* (input) {
    const current = yield* selectLiveById(input.fileSystemId, input.fileId)
    if (current === null) return { _tag: "NotFound" }
    if (current._tag === "Folder") return { _tag: "FolderNotSupported" }
    const maybePath = yield* Effect.option(
      replacePathLeaf(current.path, input.name),
    )
    if (Option.isNone(maybePath)) return { _tag: "InvalidPath" }

    const renamed = yield* runReturning(
      "rename_file",
      renameFileSql,
      [
        input.name,
        maybePath.value,
        input.actor.kind,
        input.actor.id,
        input.now,
        input.fileSystemId,
        input.fileId,
        input.fileSystemId,
        input.fileId,
        maybePath.value,
        input.name,
      ],
    )
    if (
      renamed?._tag === "PendingFile" ||
      renamed?._tag === "ReadyFile"
    ) {
      return { _tag: "Renamed", node: renamed }
    }
    if (renamed !== null) return yield* Effect.fail(invalidStoredRow())

    const afterRace = yield* selectLiveById(input.fileSystemId, input.fileId)
    if (afterRace === null) return { _tag: "NotFound" }
    if (afterRace._tag === "Folder") return { _tag: "FolderNotSupported" }
    if (
      yield* hasLiveSibling(
        input.fileSystemId,
        afterRace.parentId,
        input.name,
        input.fileId,
      )
    ) {
      return { _tag: "NameConflict" }
    }
    return yield* Effect.fail(
      unavailable(
        "rename_file",
        new Error("D1 did not classify the rejected file rename."),
      ),
    )
  })

  const softDelete: FileCatalogService["softDelete"] = Effect.fn(
    "D1FileCatalog.softDelete",
  )(function* (input) {
    const current = yield* selectLiveById(input.fileSystemId, input.fileId)
    if (current === null) return { _tag: "NotFound" }
    const descendantPrefix = `${current.path}/`
    const result = yield* attempt("soft_delete", () =>
      database
        .prepare(softDeleteSubtreeSql)
        .bind(
          input.now,
          input.actor.kind,
          input.actor.id,
          input.now,
          input.actor.kind,
          input.actor.id,
          input.reclaimAfter,
          input.reclaimAfter,
          input.fileSystemId,
          current.path,
          descendantPrefix,
          descendantPrefix,
        )
        .run(),
    )
    const parsed = yield* Schema.decodeUnknownEffect(ChangedRowsSchema)(
      result,
    ).pipe(Effect.mapError(invalidStoredRow))
    return parsed.meta.changes === 0
      ? { _tag: "NotFound" }
      : { _tag: "Deleted" }
  })

  const expirePendingBatch: FileReclamationCatalogService["expirePendingBatch"] =
    Effect.fn("D1FileReclamationCatalog.expirePendingBatch")(function* (
      input,
    ) {
      const result = yield* attempt("expire_pending_files", () =>
        database
          .prepare(expirePendingBatchSql)
          .bind(
            input.now,
            input.actor.kind,
            input.actor.id,
            input.now,
            input.actor.kind,
            input.actor.id,
            input.reclaimAfter,
            input.reclaimAfter,
            input.now,
            input.limit,
          )
          .run(),
      )
      const parsed = yield* Schema.decodeUnknownEffect(ChangedRowsSchema)(
        result,
      ).pipe(Effect.mapError(invalidStoredRow))
      return parsed.meta.changes
    })

  const listReclaimable: FileReclamationCatalogService["listReclaimable"] =
    Effect.fn("D1FileReclamationCatalog.listReclaimable")(function* (
      input,
    ) {
      const raw = yield* attempt("list_reclaimable_files", () =>
        database
          .prepare(listReclaimableSql)
          .bind(input.now, input.limit)
          .raw(),
      )
      const rows = yield* Schema.decodeUnknownEffect(
        ReclamationCandidateRowsSchema,
      )(raw).pipe(Effect.mapError(invalidStoredRow))
      return rows.map(([fileSystemId, fileId, locator]) => ({
        fileSystemId,
        fileId,
        locator,
      }))
    })

  const completeReclamation: FileReclamationCatalogService["completeReclamation"] =
    Effect.fn("D1FileReclamationCatalog.completeReclamation")(function* (
      input,
    ) {
      yield* attempt("complete_file_reclamation", () =>
        database
          .prepare(completeReclamationSql)
          .bind(
            input.now,
            input.candidate.fileSystemId,
            input.candidate.fileId,
            input.candidate.locator,
            input.now,
          )
          .run(),
      )
    })

  const deferReclamation: FileReclamationCatalogService["deferReclamation"] =
    Effect.fn("D1FileReclamationCatalog.deferReclamation")(function* (
      input,
    ) {
      yield* attempt("defer_file_reclamation", () =>
        database
          .prepare(deferReclamationSql)
          .bind(
            input.retryAt,
            input.retryAt,
            input.candidate.fileSystemId,
            input.candidate.fileId,
            input.candidate.locator,
          )
          .run(),
      )
    })

  const purgeReclaimedBatch: FileReclamationCatalogService["purgeReclaimedBatch"] =
    Effect.fn("D1FileReclamationCatalog.purgeReclaimedBatch")(function* (
      input,
    ) {
      const result = yield* attempt("purge_reclaimed_files", () =>
        database
          .prepare(purgeReclaimedBatchSql)
          .bind(input.deletedBefore, input.limit)
          .run(),
      )
      const parsed = yield* Schema.decodeUnknownEffect(ChangedRowsSchema)(
        result,
      ).pipe(Effect.mapError(invalidStoredRow))
      return parsed.meta.changes
    })

  return {
    catalog: FileCatalog.of({
      get,
      listChildren,
      createFolder,
      reserveUpload,
      confirmUpload,
      renameFile,
      softDelete,
    }),
    reclamation: FileReclamationCatalog.of({
      expirePendingBatch,
      listReclaimable,
      completeReclamation,
      deferReclamation,
      purgeReclaimedBatch,
    }),
  }
}

/** Build the D1-backed metadata catalog. */
export const makeD1FileCatalog = (
  database: D1FilesDatabase,
): FileCatalogService => makeD1Adapters(database).catalog

/** Build the D1-backed bounded-reclamation catalog. */
export const makeD1FileReclamationCatalog = (
  database: D1FilesDatabase,
): FileReclamationCatalogService => makeD1Adapters(database).reclamation

/** Provide both D1 catalog capabilities from one database binding. */
export const d1FileCatalogLayer = (
  database: D1FilesDatabase,
): Layer.Layer<FileCatalog | FileReclamationCatalog> => {
  const adapters = makeD1Adapters(database)
  return Layer.merge(
    Layer.succeed(FileCatalog, adapters.catalog),
    Layer.succeed(FileReclamationCatalog, adapters.reclamation),
  )
}
