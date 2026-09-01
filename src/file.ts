import { Effect, Schema } from "effect"

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const idempotencyPattern = /^[A-Za-z0-9._:-]+$/u
const cursorPattern = /^[A-Za-z0-9_-]+$/u
const sha256Pattern = /^[0-9a-f]{64}$/u
const mediaTypePattern = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:[ \t]*;[ \t]*[A-Za-z0-9!#$%&'*+.^_`|~-]+=(?:[A-Za-z0-9!#$%&'*+.^_`|~-]+|"[\x20-\x21\x23-\x5b\x5d-\x7e]*"))*$/u
const maximumTimestampMillis = 8_640_000_000_000_000
const hasInvalidCodePoint = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint !== undefined &&
      (codePoint <= 31 ||
        codePoint === 127 ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff))
    ) {
      return true
    }
  }
  return false
}

const identifier = <const Brand extends string>(brand: Brand) =>
  Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(200),
    Schema.isPattern(identifierPattern),
  ).pipe(Schema.brand(brand))

/** Opaque identity of one file or folder. */
export const FileIdSchema = identifier("@popcomputer/files/FileId")
/** Opaque identity of one file or folder. */
export type FileId = Schema.Schema.Type<typeof FileIdSchema>

/** Stable identity of one isolated logical filesystem. */
export const FileSystemIdSchema = identifier(
  "@popcomputer/files/FileSystemId",
)
/** Stable identity of one isolated logical filesystem. */
export type FileSystemId = Schema.Schema.Type<typeof FileSystemIdSchema>

/** Opaque identity of the actor performing one operation. */
export const FileActorIdSchema = identifier(
  "@popcomputer/files/FileActorId",
)
/** Opaque identity of the actor performing one operation. */
export type FileActorId = Schema.Schema.Type<typeof FileActorIdSchema>

/** Application-defined actor category. */
export const FileActorKindSchema = identifier(
  "@popcomputer/files/FileActorKind",
)
/** Application-defined actor category. */
export type FileActorKind = Schema.Schema.Type<typeof FileActorKindSchema>

/** Caller-owned retry identity for one mutating filesystem command. */
export const IdempotencyKeySchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(idempotencyPattern),
).pipe(Schema.brand("@popcomputer/files/IdempotencyKey"))
/** Caller-owned retry identity for one mutating filesystem command. */
export type IdempotencyKey = Schema.Schema.Type<
  typeof IdempotencyKeySchema
>

/** Non-negative byte count safe to represent in JavaScript. */
export const ByteCountSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
).pipe(Schema.brand("@popcomputer/files/ByteCount"))
/** Non-negative byte count safe to represent in JavaScript. */
export type ByteCount = Schema.Schema.Type<typeof ByteCountSchema>

/** Unix timestamp in integer milliseconds. */
export const TimestampMillisSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(maximumTimestampMillis),
).pipe(Schema.brand("@popcomputer/files/TimestampMillis"))
/** Unix timestamp in integer milliseconds. */
export type TimestampMillis = Schema.Schema.Type<
  typeof TimestampMillisSchema
>

/** Non-negative duration in integer milliseconds. */
export const DurationMillisSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(maximumTimestampMillis),
).pipe(Schema.brand("@popcomputer/files/DurationMillis"))
/** Non-negative duration in integer milliseconds. */
export type DurationMillis = Schema.Schema.Type<typeof DurationMillisSchema>

/** Maximum number of records processed by one maintenance pass. */
export const MaintenanceBatchSizeSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 100 }),
).pipe(Schema.brand("@popcomputer/files/MaintenanceBatchSize"))
/** Maximum number of records processed by one maintenance pass. */
export type MaintenanceBatchSize = Schema.Schema.Type<
  typeof MaintenanceBatchSizeSchema
>

/** Maximum number of children returned by one list request. */
export const PageSizeSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 100 }),
).pipe(Schema.brand("@popcomputer/files/PageSize"))
/** Maximum number of children returned by one list request. */
export type PageSize = Schema.Schema.Type<typeof PageSizeSchema>

/** Opaque keyset cursor returned by a catalog. */
export const PageCursorSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4096),
  Schema.isPattern(cursorPattern),
).pipe(Schema.brand("@popcomputer/files/PageCursor"))
/** Opaque keyset cursor returned by a catalog. */
export type PageCursor = Schema.Schema.Type<typeof PageCursorSchema>

const isValidSegment = (segment: string): boolean =>
  segment.length > 0 &&
  segment.length <= 255 &&
  segment !== "." &&
  !segment.startsWith("..") &&
  !segment.includes("/") &&
  !segment.includes("\\") &&
  !hasInvalidCodePoint(segment) &&
  segment === segment.trim() &&
  !segment.endsWith(".") &&
  segment === segment.normalize("NFC")

/** Canonical NFC-normalized single path segment. */
export const FileNameSchema = Schema.String.check(
  Schema.makeFilter(isValidSegment, {
    expected: "an NFC-normalized file name without traversal or separators",
  }),
).pipe(Schema.brand("@popcomputer/files/FileName"))
/** Canonical NFC-normalized single path segment. */
export type FileName = Schema.Schema.Type<typeof FileNameSchema>

const isValidRelativePath = (path: string): boolean => {
  if (
    path.length === 0 ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path !== path.normalize("NFC")
  ) {
    return false
  }
  const segments = path.split("/")
  return segments.length <= 32 && segments.every(isValidSegment)
}

/** Canonical relative path within one filesystem. */
export const RelativePathSchema = Schema.String.check(
  Schema.makeFilter(isValidRelativePath, {
    expected: "an NFC-normalized relative path with at most 32 segments",
  }),
).pipe(Schema.brand("@popcomputer/files/RelativePath"))
/** Canonical relative path within one filesystem. */
export type RelativePath = Schema.Schema.Type<typeof RelativePathSchema>

/** Absolute capability URI issued for one short-lived byte operation. */
export const CapabilityUrlSchema = Schema.String.check(
  Schema.makeFilter(
    (value: string) => {
      if (!URL.canParse(value)) return false
      const url = new URL(value)
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username.length === 0 &&
        url.password.length === 0
      )
    },
    { expected: "an absolute HTTP(S) capability URL without credentials" },
  ),
).pipe(Schema.brand("@popcomputer/files/CapabilityUrl"))
/** Absolute capability URI issued for one short-lived byte operation. */
export type CapabilityUrl = Schema.Schema.Type<typeof CapabilityUrlSchema>

/** ASCII media type safe to carry through HTTP and object metadata. */
export const FileContentTypeSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(255),
  Schema.isPattern(mediaTypePattern),
).pipe(Schema.brand("@popcomputer/files/FileContentType"))
/** ASCII media type safe to carry through HTTP and object metadata. */
export type FileContentType = Schema.Schema.Type<
  typeof FileContentTypeSchema
>

/** Parse and NFC-normalize a file name from unknown boundary input. */
export const parseFileName = (
  input: unknown,
): Effect.Effect<FileName, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(FileNameSchema)(
    typeof input === "string" ? input.normalize("NFC") : input,
  )

/** Parse and NFC-normalize a relative path from unknown boundary input. */
export const parseRelativePath = (
  input: unknown,
): Effect.Effect<RelativePath, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(RelativePathSchema)(
    typeof input === "string" ? input.normalize("NFC") : input,
  )

/** Compose and validate a child path from a parsed leaf name. */
export const childPath = (
  parentPath: RelativePath | null,
  leaf: FileName,
): Effect.Effect<RelativePath, Schema.SchemaError> =>
  parseRelativePath(parentPath === null ? leaf : `${parentPath}/${leaf}`)

/** Replace the leaf segment of a parsed path. */
export const replacePathLeaf = (
  path: RelativePath,
  leaf: FileName,
): Effect.Effect<RelativePath, Schema.SchemaError> => {
  const separator = path.lastIndexOf("/")
  return parseRelativePath(
    separator < 0 ? leaf : `${path.slice(0, separator)}/${leaf}`,
  )
}

/** Actor supplied by the authenticated host application. */
export const FileActorSchema = Schema.Struct({
  kind: FileActorKindSchema,
  id: FileActorIdSchema,
})
/** Actor supplied by the authenticated host application. */
export interface FileActor
  extends Schema.Schema.Type<typeof FileActorSchema> {}

/** Digest that does not mislabel an object-store ETag as a SHA-256. */
export const ContentDigestSchema = Schema.TaggedUnion({
  Sha256: {
    value: Schema.String.check(Schema.isPattern(sha256Pattern)),
  },
  OpaqueEtag: {
    value: Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(512),
    ),
  },
})
/** Digest that does not mislabel an object-store ETag as a SHA-256. */
export type ContentDigest = Schema.Schema.Type<typeof ContentDigestSchema>

const nodeBase = {
  id: FileIdSchema,
  parentId: Schema.NullOr(FileIdSchema),
  name: FileNameSchema,
  path: RelativePathSchema,
  createdAt: TimestampMillisSchema,
  updatedAt: TimestampMillisSchema,
}

/** Public file node state; object locators and upload bounds remain private. */
export const FileNodeSchema = Schema.TaggedUnion({
  Folder: nodeBase,
  PendingFile: nodeBase,
  ReadyFile: {
    ...nodeBase,
    size: ByteCountSchema,
    contentType: Schema.NullOr(FileContentTypeSchema),
    digest: Schema.NullOr(ContentDigestSchema),
  },
})
/** Public file node state; object locators and upload bounds remain private. */
export type FileNode = Schema.Schema.Type<typeof FileNodeSchema>
/** Public folder state. */
export type FolderNode = Extract<FileNode, { readonly _tag: "Folder" }>
/** Public pending-file state. */
export type PendingFileNode = Extract<
  FileNode,
  { readonly _tag: "PendingFile" }
>
/** Public ready-file state. */
export type ReadyFileNode = Extract<
  FileNode,
  { readonly _tag: "ReadyFile" }
>

/** Target folder for one direct-child listing. */
export const FileListTargetSchema = Schema.TaggedUnion({
  Root: {},
  FolderId: { id: FileIdSchema },
  Path: { path: RelativePathSchema },
})
/** Target folder for one direct-child listing. */
export type FileListTarget = Schema.Schema.Type<
  typeof FileListTargetSchema
>

/** Root listing target. */
export const rootListTarget: FileListTarget =
  FileListTargetSchema.cases.Root.make({})

/** One keyset-paginated page of direct children. */
export interface FilePage {
  readonly items: ReadonlyArray<FileNode>
  readonly cursor: PageCursor | null
}

/** Short-lived direct-upload ticket. */
export interface UploadTicket {
  readonly fileId: FileId
  readonly url: CapabilityUrl
  readonly expiresAt: TimestampMillis
}

/** Short-lived direct-download ticket. */
export interface DownloadTicket {
  readonly file: ReadyFileNode
  readonly url: CapabilityUrl
  readonly expiresAt: TimestampMillis
}
