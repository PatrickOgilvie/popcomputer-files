import { Schema } from "effect"
import { FilesRejectionCodeSchema } from "./errors.js"
import {
  ByteCountSchema,
  CapabilityUrlSchema,
  ContentDigestSchema,
  FileContentTypeSchema,
  FileIdSchema,
  FileNameSchema,
  IdempotencyKeySchema,
  PageCursorSchema,
  RelativePathSchema,
  Sha256Schema,
  TimestampMillisSchema,
  type DownloadTicket,
  type FileNode,
  type FilePage,
  type UploadTicket,
} from "./file.js"

/** Canonical ISO-8601 timestamp with millisecond precision, as responses carry. */
export const IsoTimestampSchema = Schema.String.check(
  Schema.makeFilter(
    (value: string) => {
      const timestamp = Date.parse(value)
      return (
        Number.isFinite(timestamp) &&
        timestamp >= 0 &&
        new Date(timestamp).toISOString() === value
      )
    },
    { expected: "a canonical ISO-8601 timestamp" },
  ),
)

const dtoBase = {
  id: FileIdSchema,
  name: FileNameSchema,
  parentId: Schema.NullOr(FileIdSchema),
  path: RelativePathSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}

const FolderNodeDtoSchema = Schema.Struct({
  ...dtoBase,
  kind: Schema.Literal("folder"),
  status: Schema.Literal("ready"),
  size: Schema.Null,
  contentType: Schema.Null,
  digest: Schema.Null,
})

const PendingFileNodeDtoSchema = Schema.Struct({
  ...dtoBase,
  kind: Schema.Literal("file"),
  status: Schema.Literal("pending"),
  size: Schema.Null,
  contentType: Schema.Null,
  digest: Schema.Null,
})

const ReadyFileNodeDtoSchema = Schema.Struct({
  ...dtoBase,
  kind: Schema.Literal("file"),
  status: Schema.Literal("ready"),
  size: ByteCountSchema,
  contentType: Schema.NullOr(FileContentTypeSchema),
  digest: Schema.NullOr(ContentDigestSchema),
})

type ReadyFileNodeDto = Schema.Schema.Type<typeof ReadyFileNodeDtoSchema>

/** Strict public JSON representation of one filesystem node. */
export const FileNodeDtoSchema = Schema.Union([
  FolderNodeDtoSchema,
  PendingFileNodeDtoSchema,
  ReadyFileNodeDtoSchema,
])
/** Strict public JSON representation of one filesystem node. */
export type FileNodeDto = Schema.Schema.Type<typeof FileNodeDtoSchema>

/** Strict list response shared by the HTTP handler and client. */
export const FilePageDtoSchema = Schema.Struct({
  items: Schema.Array(FileNodeDtoSchema),
  cursor: Schema.NullOr(PageCursorSchema),
})
/** Strict list response shared by the HTTP handler and client. */
export type FilePageDto = Schema.Schema.Type<typeof FilePageDtoSchema>

/** Strict create-folder request body before file-name normalization. */
export const CreateFolderBodySchema = Schema.Struct({
  parentId: Schema.NullOr(FileIdSchema),
  name: Schema.String,
})

/** Strict upload-reservation request body before file-name normalization. */
export const RequestUploadBodySchema = Schema.Struct({
  parentId: Schema.NullOr(FileIdSchema),
  name: Schema.String,
  size: ByteCountSchema,
  /** Optional SHA-256 the stored bytes must have. */
  sha256: Schema.optionalKey(Schema.NullOr(Sha256Schema)),
  /** Optional media type recorded whatever the upload request sends. */
  contentType: Schema.optionalKey(Schema.NullOr(FileContentTypeSchema)),
})

/**
 * Strict move request body before file-name normalization. Without
 * `parentId` the node stays in its folder and is only renamed.
 */
export const MoveNodeBodySchema = Schema.Struct({
  name: Schema.String,
  parentId: Schema.optionalKey(Schema.NullOr(FileIdSchema)),
  expectedUpdatedAt: Schema.optionalKey(IsoTimestampSchema),
})

/** Strict upload-ticket response. */
export const UploadTicketDtoSchema = Schema.Struct({
  fileId: FileIdSchema,
  uploadUrl: CapabilityUrlSchema,
  expiresAt: IsoTimestampSchema,
})
/** Strict upload-ticket response. */
export type UploadTicketDto = Schema.Schema.Type<
  typeof UploadTicketDtoSchema
>

/** Strict download-ticket response. */
export const DownloadTicketDtoSchema = Schema.Struct({
  file: ReadyFileNodeDtoSchema,
  url: CapabilityUrlSchema,
  expiresAt: IsoTimestampSchema,
})
/** Strict download-ticket response. */
export type DownloadTicketDto = Schema.Schema.Type<
  typeof DownloadTicketDtoSchema
>

/** Strict node response used by create, confirm, and move. */
export const FileNodeResponseDtoSchema = Schema.Struct({
  node: FileNodeDtoSchema,
})
/** Strict node response used by create, confirm, and move. */
export type FileNodeResponseDto = Schema.Schema.Type<
  typeof FileNodeResponseDtoSchema
>

/** Strict public error envelope. */
export const FileErrorDtoSchema = Schema.Struct({
  error: Schema.Struct({
    code: FilesRejectionCodeSchema,
    message: Schema.String,
  }),
})
/** Strict public error envelope. */
export type FileErrorDto = Schema.Schema.Type<typeof FileErrorDtoSchema>

/** Strict folder-create idempotency-key header schema. */
export const FolderIdempotencyKeySchema = IdempotencyKeySchema

/** Strict upload-reservation idempotency-key header schema. */
export const UploadIdempotencyKeySchema = IdempotencyKeySchema

const readyFileNodeToDto = (node: Extract<FileNode, { readonly _tag: "ReadyFile" }>): ReadyFileNodeDto => ({
  id: node.id,
  name: node.name,
  parentId: node.parentId,
  path: node.path,
  createdAt: new Date(node.createdAt).toISOString(),
  updatedAt: new Date(node.updatedAt).toISOString(),
  kind: "file",
  status: "ready",
  size: node.size,
  contentType: node.contentType,
  digest: node.digest,
})

/** Project one domain node to its public JSON representation. */
export const fileNodeToDto = (node: FileNode): FileNodeDto => {
  const base = {
    id: node.id,
    name: node.name,
    parentId: node.parentId,
    path: node.path,
    createdAt: new Date(node.createdAt).toISOString(),
    updatedAt: new Date(node.updatedAt).toISOString(),
  }
  switch (node._tag) {
    case "Folder":
      return {
        ...base,
        kind: "folder",
        status: "ready",
        size: null,
        contentType: null,
        digest: null,
      }
    case "PendingFile":
      return {
        ...base,
        kind: "file",
        status: "pending",
        size: null,
        contentType: null,
        digest: null,
      }
    case "ReadyFile":
      return readyFileNodeToDto(node)
  }
}

/** Millisecond timestamp of a strictly decoded ISO-8601 string. */
export const timestampFromIso = (value: string) =>
  TimestampMillisSchema.make(Date.parse(value))

/** Reconstruct one domain node from a strictly decoded response DTO. */
export const fileNodeFromDto = (dto: FileNodeDto): FileNode => {
  const base = {
    id: dto.id,
    name: dto.name,
    parentId: dto.parentId,
    path: dto.path,
    createdAt: timestampFromIso(dto.createdAt),
    updatedAt: timestampFromIso(dto.updatedAt),
  }
  if (dto.kind === "folder") {
    return { _tag: "Folder", ...base }
  }
  if (dto.status === "pending") {
    return { _tag: "PendingFile", ...base }
  }
  return {
    _tag: "ReadyFile",
    ...base,
    size: dto.size,
    contentType: dto.contentType,
    digest: dto.digest,
  }
}

/** Project one domain page to the strict public JSON representation. */
export const filePageToDto = (page: FilePage): FilePageDto => ({
  items: page.items.map(fileNodeToDto),
  cursor: page.cursor,
})

/** Reconstruct one domain page from a strictly decoded response DTO. */
export const filePageFromDto = (dto: FilePageDto): FilePage => ({
  items: dto.items.map(fileNodeFromDto),
  cursor: dto.cursor,
})

/** Project an upload ticket to its public response DTO. */
export const uploadTicketToDto = (ticket: UploadTicket): UploadTicketDto => ({
  fileId: ticket.fileId,
  uploadUrl: ticket.url,
  expiresAt: new Date(ticket.expiresAt).toISOString(),
})

/** Reconstruct an upload ticket from a strictly decoded response DTO. */
export const uploadTicketFromDto = (dto: UploadTicketDto): UploadTicket => ({
  fileId: dto.fileId,
  url: dto.uploadUrl,
  expiresAt: timestampFromIso(dto.expiresAt),
})

/** Project a download ticket to its public response DTO. */
export const downloadTicketToDto = (
  ticket: DownloadTicket,
): DownloadTicketDto => ({
  file: readyFileNodeToDto(ticket.file),
  url: ticket.url,
  expiresAt: new Date(ticket.expiresAt).toISOString(),
})

/** Reconstruct a download ticket from a strictly decoded response DTO. */
export const downloadTicketFromDto = (
  dto: DownloadTicketDto,
): DownloadTicket => ({
  file: {
    _tag: "ReadyFile",
    id: dto.file.id,
    name: dto.file.name,
    parentId: dto.file.parentId,
    path: dto.file.path,
    createdAt: timestampFromIso(dto.file.createdAt),
    updatedAt: timestampFromIso(dto.file.updatedAt),
    size: dto.file.size,
    contentType: dto.file.contentType,
    digest: dto.file.digest,
  },
  url: dto.url,
  expiresAt: timestampFromIso(dto.expiresAt),
})
