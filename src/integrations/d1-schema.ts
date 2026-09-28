import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

/** D1 metadata for logical filesystem nodes and byte-object reclamation. */
export const d1Files = sqliteTable(
  "popcomputer_files",
  {
    fileSystemId: text("file_system_id").notNull(),
    id: text("id").notNull(),
    parentId: text("parent_id"),
    kind: text("kind", { enum: ["folder", "file"] }).notNull(),
    status: text("status", { enum: ["pending", "ready"] }).notNull(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    locator: text("locator"),
    maximumBytes: integer("maximum_bytes"),
    pendingExpiresAt: integer("pending_expires_at"),
    size: integer("size"),
    contentType: text("content_type"),
    digestKind: text("digest_kind", {
      enum: ["sha256", "opaque_etag"],
    }),
    digestValue: text("digest_value"),
    createdActorKind: text("created_actor_kind").notNull(),
    createdActorId: text("created_actor_id").notNull(),
    updatedActorKind: text("updated_actor_kind").notNull(),
    updatedActorId: text("updated_actor_id").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
    deletedActorKind: text("deleted_actor_kind"),
    deletedActorId: text("deleted_actor_id"),
    reclaimAfter: integer("reclaim_after"),
    objectReclaimedAt: integer("object_reclaimed_at"),
    expectedSha256: text("expected_sha256"),
  },
  (table) => [
    primaryKey({
      name: "popcomputer_files_pk",
      columns: [table.fileSystemId, table.id],
    }),
    foreignKey({
      name: "popcomputer_files_parent_fk",
      columns: [table.fileSystemId, table.parentId],
      foreignColumns: [table.fileSystemId, table.id],
    }).onDelete("restrict"),
    check(
      "popcomputer_files_identity_check",
      sql`length(${table.fileSystemId}) BETWEEN 1 AND 200
        AND length(${table.id}) BETWEEN 1 AND 200
        AND (${table.parentId} IS NULL OR ${table.parentId} <> ${table.id})`,
    ),
    check(
      "popcomputer_files_name_path_check",
      sql`length(${table.name}) BETWEEN 1 AND 255
        AND length(${table.path}) BETWEEN 1 AND 1024
        AND (
          ${table.path} = ${table.name}
          OR substr(${table.path}, -(length(${table.name}) + 1)) = '/' || ${table.name}
        )`,
    ),
    check(
      "popcomputer_files_time_check",
      sql`${table.createdAt} >= 0
        AND ${table.updatedAt} >= ${table.createdAt}
        AND (${table.pendingExpiresAt} IS NULL OR ${table.pendingExpiresAt} >= ${table.createdAt})
        AND (${table.deletedAt} IS NULL OR ${table.deletedAt} >= ${table.createdAt})
        AND (${table.reclaimAfter} IS NULL OR ${table.reclaimAfter} >= ${table.deletedAt})
        AND (${table.objectReclaimedAt} IS NULL OR ${table.objectReclaimedAt} >= ${table.reclaimAfter})`,
    ),
    check(
      "popcomputer_files_deletion_check",
      sql`(
          ${table.deletedAt} IS NULL
          AND ${table.deletedActorKind} IS NULL
          AND ${table.deletedActorId} IS NULL
          AND ${table.reclaimAfter} IS NULL
          AND ${table.objectReclaimedAt} IS NULL
        ) OR (
          ${table.deletedAt} IS NOT NULL
          AND ${table.deletedActorKind} IS NOT NULL
          AND ${table.deletedActorId} IS NOT NULL
          AND ${table.reclaimAfter} IS NOT NULL
          AND (${table.objectReclaimedAt} IS NULL OR ${table.locator} IS NOT NULL)
        )`,
    ),
    check(
      "popcomputer_files_digest_check",
      sql`(
          ${table.digestKind} IS NULL
          AND ${table.digestValue} IS NULL
        ) OR (
          ${table.digestKind} = 'sha256'
          AND ${table.digestValue} IS NOT NULL
          AND length(${table.digestValue}) = 64
          AND ${table.digestValue} NOT GLOB '*[^0-9a-f]*'
        ) OR (
          ${table.digestKind} = 'opaque_etag'
          AND ${table.digestValue} IS NOT NULL
          AND length(${table.digestValue}) BETWEEN 1 AND 512
        )`,
    ),
    check(
      "popcomputer_files_lifecycle_check",
      sql`(
          ${table.kind} = 'folder'
          AND ${table.status} = 'ready'
          AND ${table.locator} IS NULL
          AND ${table.maximumBytes} IS NULL
          AND ${table.pendingExpiresAt} IS NULL
          AND ${table.size} IS NULL
          AND ${table.contentType} IS NULL
          AND ${table.digestKind} IS NULL
          AND ${table.digestValue} IS NULL
        ) OR (
          ${table.kind} = 'file'
          AND ${table.status} = 'pending'
          AND ${table.locator} IS NOT NULL
          AND ${table.maximumBytes} IS NOT NULL
          AND typeof(${table.maximumBytes}) = 'integer'
          AND ${table.maximumBytes} >= 0
          AND ${table.pendingExpiresAt} IS NOT NULL
          AND ${table.size} IS NULL
          AND ${table.contentType} IS NULL
          AND ${table.digestKind} IS NULL
          AND ${table.digestValue} IS NULL
        ) OR (
          ${table.kind} = 'file'
          AND ${table.status} = 'ready'
          AND ${table.locator} IS NOT NULL
          AND ${table.maximumBytes} IS NOT NULL
          AND typeof(${table.maximumBytes}) = 'integer'
          AND ${table.maximumBytes} >= 0
          AND ${table.pendingExpiresAt} IS NULL
          AND ${table.size} IS NOT NULL
          AND typeof(${table.size}) = 'integer'
          AND ${table.size} >= 0
          AND (${table.contentType} IS NULL OR length(${table.contentType}) BETWEEN 1 AND 255)
        )`,
    ),
    uniqueIndex("popcomputer_files_live_sibling_uq")
      .on(
        table.fileSystemId,
        sql`coalesce(${table.parentId}, '')`,
        table.name,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("popcomputer_files_live_path_uq")
      .on(table.fileSystemId, table.path)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("popcomputer_files_locator_uq")
      .on(table.locator)
      .where(sql`${table.locator} IS NOT NULL`),
    index("popcomputer_files_children_idx")
      .on(
        table.fileSystemId,
        table.parentId,
        sql`${table.kind} DESC`,
        table.name,
        table.id,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    index("popcomputer_files_quota_idx").on(
      table.fileSystemId,
      table.status,
      table.deletedAt,
    ),
    index("popcomputer_files_pending_expiry_idx")
      .on(table.pendingExpiresAt, table.fileSystemId, table.id)
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.kind} = 'file' AND ${table.status} = 'pending'`,
      ),
    index("popcomputer_files_reclamation_idx")
      .on(table.reclaimAfter, table.fileSystemId, table.id)
      .where(
        sql`${table.deletedAt} IS NOT NULL AND ${table.locator} IS NOT NULL AND ${table.objectReclaimedAt} IS NULL`,
      ),
    index("popcomputer_files_purge_idx")
      .on(table.deletedAt, table.fileSystemId, table.id)
      .where(sql`${table.deletedAt} IS NOT NULL`),
  ],
)

/** Immutable D1 command ledger for folder-create idempotency. */
export const d1FileFolderRequests = sqliteTable(
  "popcomputer_file_folder_requests",
  {
    fileSystemId: text("file_system_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    fileId: text("file_id").notNull(),
    requestedParentId: text("requested_parent_id"),
    requestedName: text("requested_name").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "popcomputer_file_folder_requests_pk",
      columns: [table.fileSystemId, table.idempotencyKey],
    }),
    uniqueIndex("popcomputer_file_folder_requests_file_uq").on(
      table.fileSystemId,
      table.fileId,
    ),
    check(
      "popcomputer_file_folder_requests_identity_check",
      sql`length(${table.fileSystemId}) BETWEEN 1 AND 200
        AND length(${table.idempotencyKey}) BETWEEN 1 AND 128
        AND length(${table.fileId}) BETWEEN 1 AND 200
        AND (${table.requestedParentId} IS NULL OR ${table.requestedParentId} <> ${table.fileId})`,
    ),
    check(
      "popcomputer_file_folder_requests_command_check",
      sql`length(${table.requestedName}) BETWEEN 1 AND 255
        AND ${table.createdAt} >= 0`,
    ),
  ],
)

/** Immutable D1 command ledger for upload idempotency. */
export const d1FileUploadRequests = sqliteTable(
  "popcomputer_file_upload_requests",
  {
    fileSystemId: text("file_system_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    fileId: text("file_id").notNull(),
    requestedParentId: text("requested_parent_id"),
    requestedName: text("requested_name").notNull(),
    requestedMaximumBytes: integer("requested_maximum_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
    requestedSha256: text("requested_sha256"),
  },
  (table) => [
    primaryKey({
      name: "popcomputer_file_upload_requests_pk",
      columns: [table.fileSystemId, table.idempotencyKey],
    }),
    uniqueIndex("popcomputer_file_upload_requests_file_uq").on(
      table.fileSystemId,
      table.fileId,
    ),
    check(
      "popcomputer_file_upload_requests_identity_check",
      sql`length(${table.fileSystemId}) BETWEEN 1 AND 200
        AND length(${table.idempotencyKey}) BETWEEN 1 AND 128
        AND length(${table.fileId}) BETWEEN 1 AND 200
        AND (${table.requestedParentId} IS NULL OR ${table.requestedParentId} <> ${table.fileId})`,
    ),
    check(
      "popcomputer_file_upload_requests_command_check",
      sql`length(${table.requestedName}) BETWEEN 1 AND 255
        AND typeof(${table.requestedMaximumBytes}) = 'integer'
        AND ${table.requestedMaximumBytes} >= 0
        AND ${table.createdAt} >= 0`,
    ),
  ],
)

/** Commit-ordered log of visible changes, written by catalog triggers. */
export const d1FileChanges = sqliteTable(
  "popcomputer_file_changes",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    fileSystemId: text("file_system_id").notNull(),
    kind: text("kind", {
      enum: ["folder_created", "file_ready", "node_moved", "node_deleted"],
    }).notNull(),
    fileId: text("file_id").notNull(),
    nodeKind: text("node_kind", { enum: ["folder", "file"] }).notNull(),
    path: text("path").notNull(),
    previousPath: text("previous_path"),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  (table) => [
    index("popcomputer_file_changes_filesystem_idx").on(
      table.fileSystemId,
      table.sequence,
    ),
    index("popcomputer_file_changes_recorded_idx").on(
      table.recordedAt,
      table.sequence,
    ),
  ],
)

/** Drizzle-inferred persisted change-log row shape. */
export type D1FileChangeRow = typeof d1FileChanges.$inferSelect

/** Drizzle-inferred persisted file-row shape. */
export type D1FileRow = typeof d1Files.$inferSelect

/** Drizzle-inferred persisted folder-request row shape. */
export type D1FileFolderRequestRow =
  typeof d1FileFolderRequests.$inferSelect

/** Drizzle-inferred persisted upload-request row shape. */
export type D1FileUploadRequestRow =
  typeof d1FileUploadRequests.$inferSelect
