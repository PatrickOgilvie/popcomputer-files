import { Schema } from "effect"
import { FileIdSchema } from "./file.js"

/** Stable public error codes returned by the standard HTTP control plane. */
export const FilesRejectionCodeSchema = Schema.Literals([
  "file_not_found",
  "file_store_unavailable",
  "file_too_large",
  "folder_unavailable",
  "folder_required",
  "forbidden",
  "idempotency_conflict",
  "internal_error",
  "invalid_body",
  "invalid_cursor",
  "invalid_file_id",
  "invalid_file_name",
  "invalid_file_node",
  "invalid_path",
  "invalid_size",
  "name_conflict",
  "not_a_file",
  "quota_exceeded",
  "unauthorized",
  "upload_already_confirmed",
  "upload_unavailable",
  "upload_not_found",
])
/** Stable public error code returned by the standard HTTP control plane. */
export type FilesRejectionCode = Schema.Schema.Type<
  typeof FilesRejectionCodeSchema
>

/** Boundary input did not satisfy a filesystem contract. */
export class InvalidFileInput extends Schema.TaggedError<InvalidFileInput>()(
  "InvalidFileInput",
  {
    reason: Schema.Literals([
      "invalid_body",
      "invalid_cursor",
      "invalid_file_id",
      "invalid_file_name",
      "invalid_path",
      "invalid_size",
    ]),
  },
) {}

/** The requested live file or folder does not exist in the filesystem. */
export class FileNotFound extends Schema.TaggedError<FileNotFound>()(
  "FileNotFound",
  { fileId: Schema.NullOr(FileIdSchema) },
) {}

/** An operation requiring a folder was given a file. */
export class FolderRequired extends Schema.TaggedError<FolderRequired>()(
  "FolderRequired",
  { fileId: FileIdSchema },
) {}

/** Folder rename is outside this version's supported lifecycle. */
export class FileRequired extends Schema.TaggedError<FileRequired>()(
  "FileRequired",
  { fileId: FileIdSchema },
) {}

/** A live sibling already owns the requested name. */
export class FileNameConflict extends Schema.TaggedError<FileNameConflict>()(
  "FileNameConflict",
  {},
) {}

/** An idempotency key was replayed with a different command fingerprint. */
export class IdempotencyConflict extends Schema.TaggedError<IdempotencyConflict>()(
  "IdempotencyConflict",
  {},
) {}

/** A folder-create command refers to a folder that was deleted or purged. */
export class FolderNoLongerAvailable extends Schema.TaggedError<FolderNoLongerAvailable>()(
  "FolderNoLongerAvailable",
  { fileId: FileIdSchema },
) {}

/** An upload reservation key refers to a file already confirmed. */
export class UploadAlreadyConfirmed extends Schema.TaggedError<UploadAlreadyConfirmed>()(
  "UploadAlreadyConfirmed",
  { fileId: FileIdSchema },
) {}

/** An upload command refers to a file that has been deleted or purged. */
export class UploadNoLongerAvailable extends Schema.TaggedError<UploadNoLongerAvailable>()(
  "UploadNoLongerAvailable",
  { fileId: FileIdSchema },
) {}

/** No uploaded object exists for a pending file. */
export class UploadNotFound extends Schema.TaggedError<UploadNotFound>()(
  "UploadNotFound",
  { fileId: FileIdSchema },
) {}

/** Uploaded or requested bytes exceed the configured upload bound. */
export class FileTooLarge extends Schema.TaggedError<FileTooLarge>()(
  "FileTooLarge",
  {},
) {}

/** Confirming the upload would exceed its filesystem quota. */
export class FileQuotaExceeded extends Schema.TaggedError<FileQuotaExceeded>()(
  "FileQuotaExceeded",
  {},
) {}

/** The host could not resolve the current quota for a filesystem. */
export class FileQuotaPolicyUnavailable extends Schema.TaggedError<FileQuotaPolicyUnavailable>()(
  "FileQuotaPolicyUnavailable",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Persisted metadata violated the package's file-node state machine. */
export class InvalidStoredFile extends Schema.TaggedError<InvalidStoredFile>()(
  "InvalidStoredFile",
  { reason: Schema.String },
) {}

/** The catalog dependency could not complete an operation. */
export class FileCatalogUnavailable extends Schema.TaggedError<FileCatalogUnavailable>()(
  "FileCatalogUnavailable",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** The byte-object dependency could not complete an operation. */
export class FileObjectStoreUnavailable extends Schema.TaggedError<FileObjectStoreUnavailable>()(
  "FileObjectStoreUnavailable",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** A short-lived upload or download capability could not be issued. */
export class FileCapabilityUnavailable extends Schema.TaggedError<FileCapabilityUnavailable>()(
  "FileCapabilityUnavailable",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** A capability token is malformed, expired, or for the wrong operation. */
export class InvalidFileCapability extends Schema.TaggedError<InvalidFileCapability>()(
  "InvalidFileCapability",
  { reason: Schema.Literals(["expired", "invalid", "operation_mismatch"]) },
) {}

/** An activity sink rejected a best-effort operational event. */
export class FileActivityUnavailable extends Schema.TaggedError<FileActivityUnavailable>()(
  "FileActivityUnavailable",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** The control-plane request is not authenticated. */
export class FilesUnauthorized extends Schema.TaggedError<FilesUnauthorized>()(
  "FilesUnauthorized",
  {},
) {}

/** The authenticated caller lacks the required permission. */
export class FilesForbidden extends Schema.TaggedError<FilesForbidden>()(
  "FilesForbidden",
  {},
) {}

/** A typed HTTP client transport or protocol operation failed. */
export class FilesClientError extends Schema.TaggedError<FilesClientError>()(
  "FilesClientError",
  {
    reason: Schema.Literals([
      "cancelled",
      "invalid_response",
      "network",
      "rejected",
    ]),
    operation: Schema.String,
    status: Schema.NullOr(Schema.Number),
    code: Schema.NullOr(FilesRejectionCodeSchema),
    cause: Schema.Defect(),
  },
) {}
