import { Clock, Effect, Layer, Option, Redacted, Schema } from "effect"
import {
  FileObjectLocatorSchema,
  FileObjects,
  type FileObjectMetadata,
  type FileObjectsService,
} from "../adapter.js"
import {
  FileCapabilityUnavailable,
  FileObjectStoreUnavailable,
  InvalidFileCapability,
} from "../errors.js"
import {
  ByteCountSchema,
  CapabilityUrlSchema,
  FileContentTypeSchema,
  FileNameSchema,
  Sha256Schema,
  TimestampMillisSchema,
  type ContentDigest,
  type FileName,
  type FileContentType,
} from "../file.js"

const capabilityTokenVersion = "v2"
const maximumCapabilityTokenLength = 4096
const defaultUploadCapabilityTtlMillis = 60_000
const defaultDownloadCapabilityTtlMillis = 300_000
const defaultMaximumUploadDurationMillis = 300_000
const defaultClockSkewAllowanceMillis = 30_000
const defaultCapabilityPath = "/o/"
const defaultKeyPrefix = "files/v1/"
const maximumKeyPrefixLength = 512
const objectCorsMethodsHeader = "GET, PUT, OPTIONS"
const objectCorsRequestHeadersHeader = "Content-Type"
const objectCorsExposeHeadersHeader =
  "Content-Disposition, Content-Length, Content-Type, ETag"
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true })
const importedSigningKeys = new WeakMap<
  Redacted.Redacted<string>,
  Promise<CryptoKey>
>()

/** Longest lifetime accepted when minting a file capability. */
export const MAX_FILE_CAPABILITY_TTL_MILLIS = 15 * 60 * 1000

/** Minimum UTF-8 length accepted for a high-entropy HMAC signing secret. */
export const MINIMUM_FILE_SIGNING_SECRET_BYTES = 32

/** HTTP metadata used by the structural R2 port. */
export interface R2HttpMetadataPort {
  readonly contentType?: string
}

/** Checksums R2 kept because the writer supplied them. */
export interface R2ChecksumsPort {
  readonly sha256?: ArrayBuffer
}

/** Object metadata returned by the structural R2 port. */
export interface R2ObjectPort {
  readonly size: number
  readonly etag: string
  readonly httpEtag?: string
  readonly httpMetadata?: R2HttpMetadataPort
  readonly checksums?: R2ChecksumsPort
}

/** Downloadable object returned by the structural R2 port. */
export interface R2ObjectBodyPort extends R2ObjectPort {
  readonly body: ReadableStream<Uint8Array>
}

/** Minimal successful result of one structural R2 put. */
export interface R2PutResultPort {
  readonly etag: string
}

/** Write precondition used to make upload capabilities single-use. */
export interface R2PutConditionPort {
  readonly etagDoesNotMatch: "*"
}

/** Minimal R2-compatible object-store shape needed by this integration. */
export interface R2BucketPort {
  readonly head: (key: string) => PromiseLike<R2ObjectPort | null>
  readonly get: (key: string) => PromiseLike<R2ObjectBodyPort | null>
  readonly put: (
    key: string,
    value: ReadableStream<Uint8Array> | null,
    options: {
      readonly httpMetadata: R2HttpMetadataPort
      readonly onlyIf: R2PutConditionPort
      /** Hex SHA-256 R2 verifies before storing, and keeps for `head`. */
      readonly sha256?: string
    },
  ) => PromiseLike<R2PutResultPort | null>
  /** Idempotently remove one object; deleting an absent key succeeds. */
  readonly delete: (key: string) => PromiseLike<void>
}

/** Operation authorized by one file data-plane capability. */
export type FileCapabilityOperation = "get" | "put"

/** Runtime schema for a version-two bounded upload capability. */
export const UploadFileCapabilityClaimsSchema = Schema.Struct({
  version: Schema.Literal(2),
  operation: Schema.Literal("put"),
  locator: FileObjectLocatorSchema,
  expiresAt: TimestampMillisSchema,
  maximumBytes: ByteCountSchema,
  /** When set, R2 rejects bytes with any other digest. */
  sha256: Schema.NullOr(Sha256Schema),
  /** When set, stored as the object's media type instead of the request's. */
  contentType: Schema.NullOr(FileContentTypeSchema),
})

/** Signed claim granting one bounded direct upload. */
export type UploadFileCapabilityClaims = Schema.Schema.Type<
  typeof UploadFileCapabilityClaimsSchema
>

/** Runtime schema for a version-two attachment download capability. */
export const DownloadFileCapabilityClaimsSchema = Schema.Struct({
  version: Schema.Literal(2),
  operation: Schema.Literal("get"),
  locator: FileObjectLocatorSchema,
  expiresAt: TimestampMillisSchema,
  fileName: FileNameSchema,
})

/** Signed claim granting one attachment download. */
export type DownloadFileCapabilityClaims = Schema.Schema.Type<
  typeof DownloadFileCapabilityClaimsSchema
>

/** Runtime schema for the strict version-two capability union. */
export const FileCapabilityClaimsSchema = Schema.Union([
  UploadFileCapabilityClaimsSchema,
  DownloadFileCapabilityClaimsSchema,
])

/** Strict version-two file capability claim union. */
export type FileCapabilityClaims = Schema.Schema.Type<
  typeof FileCapabilityClaimsSchema
>

const validatedCapabilityPolicy = Symbol(
  "@popcomputer/files/CloudflareFileCapabilityPolicy",
)

/** Optional durations used to construct one validated capability policy. */
export interface CloudflareFileCapabilityPolicyOptions {
  readonly uploadCapabilityTtlMillis?: number
  readonly downloadCapabilityTtlMillis?: number
  readonly maximumUploadDurationMillis?: number
  readonly clockSkewAllowanceMillis?: number
}

/** Shared, validated timing policy for capability issuance and enforcement. */
export interface CloudflareFileCapabilityPolicy {
  readonly uploadCapabilityTtlMillis: number
  readonly downloadCapabilityTtlMillis: number
  readonly maximumUploadDurationMillis: number
  readonly clockSkewAllowanceMillis: number
  readonly reclamationGraceMillis: number
  readonly [validatedCapabilityPolicy]: true
}

/** Configuration for the Cloudflare-backed FileObjects adapter. */
export interface CloudflareFileObjectsOptions {
  readonly bucket: R2BucketPort
  readonly capabilityOrigin: URL
  readonly signingSecret: Redacted.Redacted<string>
  readonly capabilityPolicy: CloudflareFileCapabilityPolicy
  /**
   * Object keys are `{keyPrefix}{uuid}`. A host that shares a bucket gives
   * each filesystem its own prefix. Defaults to `files/v1/`.
   */
  readonly keyPrefix?: string
  /** Path under the origin where the data plane is mounted. Defaults to `/o/`. */
  readonly capabilityPath?: string
  /** Explicit development escape hatch for an HTTP capability origin. */
  readonly allowInsecureHttp?: boolean
}

/** Configuration for the cookieless Fetch data-plane handler. */
export interface CloudflareFileDataPlaneOptions {
  readonly bucket: R2BucketPort
  readonly signingSecret: Redacted.Redacted<string>
  readonly capabilityPolicy: CloudflareFileCapabilityPolicy
  /** Path the handler is mounted at; must match the issuer's. Defaults to `/o/`. */
  readonly capabilityPath?: string
  readonly allowedOrigins?: ReadonlyArray<string>
  readonly now?: () => number
  /** Explicit development escape hatch for cleartext data-plane requests. */
  readonly allowInsecureHttp?: boolean
}

/** Standard Fetch handler serving signed direct uploads and downloads. */
export type CloudflareFileDataPlaneHandler = (
  request: Request,
) => Promise<Response>

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "")
}

const base64UrlToBytes = (value: string): Uint8Array | null => {
  if (
    value.length === 0 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return null
  }

  try {
    const padded = value
      .replace(/-/gu, "+")
      .replace(/_/gu, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=")
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytesToBase64Url(bytes) === value ? bytes : null
  } catch {
    return null
  }
}

const copyToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

const importSigningKey = (
  secret: Redacted.Redacted<string>,
): Promise<CryptoKey> => {
  const cached = importedSigningKeys.get(secret)
  if (cached !== undefined) {
    return cached
  }

  const secretBytes = textEncoder.encode(Redacted.value(secret))
  if (secretBytes.byteLength < MINIMUM_FILE_SIGNING_SECRET_BYTES) {
    return Promise.reject(
      new Error("The file capability signing secret is too short."),
    )
  }

  const imported = crypto.subtle
    .importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    )
    .catch((cause: unknown) => {
      importedSigningKeys.delete(secret)
      throw cause
    })
  importedSigningKeys.set(secret, imported)
  return imported
}

const isSafeTimestamp = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0

const isByteCount = Schema.is(ByteCountSchema)
const isFileCapabilityClaims = Schema.is(FileCapabilityClaimsSchema)

const assertMintableClaims = (
  claims: FileCapabilityClaims,
  now: number,
): void => {
  if (
    !isFileCapabilityClaims(claims) ||
    !isSafeTimestamp(now) ||
    claims.expiresAt <= now ||
    claims.expiresAt > now + MAX_FILE_CAPABILITY_TTL_MILLIS
  ) {
    throw new Error("File capability claims are invalid.")
  }
}

/** Mint a versioned HMAC-SHA256 file capability token. */
export const mintFileCapability = (
  claims: FileCapabilityClaims,
  signingSecret: Redacted.Redacted<string>,
  now: number,
): Effect.Effect<string, FileCapabilityUnavailable> =>
  Effect.tryPromise({
    try: async () => {
      assertMintableClaims(claims, now)
      const payload = bytesToBase64Url(
        textEncoder.encode(JSON.stringify(claims)),
      )
      const key = await importSigningKey(signingSecret)
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        textEncoder.encode(`${capabilityTokenVersion}.${payload}`),
      )
      return `${capabilityTokenVersion}.${payload}.${bytesToBase64Url(
        new Uint8Array(signature),
      )}`
    },
    catch: (cause) =>
      new FileCapabilityUnavailable({
        operation: "sign_capability",
        cause,
      }),
  })

type CapabilityVerificationDecision =
  | { readonly _tag: "Valid"; readonly claims: FileCapabilityClaims }
  | {
      readonly _tag: "Rejected"
      readonly reason: "expired" | "invalid" | "operation_mismatch"
    }

const verifyCapabilityDecision = async (input: {
  readonly token: string
  readonly signingSecret: Redacted.Redacted<string>
  readonly expectedOperation: FileCapabilityOperation
  readonly now: number
}): Promise<CapabilityVerificationDecision> => {
  if (
    input.token.length === 0 ||
    input.token.length > maximumCapabilityTokenLength ||
    !isSafeTimestamp(input.now)
  ) {
    return { _tag: "Rejected", reason: "invalid" }
  }

  const parts = input.token.split(".")
  const version = parts[0]
  const payload = parts[1]
  const encodedSignature = parts[2]
  if (
    parts.length !== 3 ||
    version !== capabilityTokenVersion ||
    payload === undefined ||
    encodedSignature === undefined
  ) {
    return { _tag: "Rejected", reason: "invalid" }
  }

  const signature = base64UrlToBytes(encodedSignature)
  if (signature === null || signature.byteLength !== 32) {
    return { _tag: "Rejected", reason: "invalid" }
  }

  const key = await importSigningKey(input.signingSecret)
  const validSignature = await crypto.subtle.verify(
    "HMAC",
    key,
    copyToArrayBuffer(signature),
    textEncoder.encode(`${version}.${payload}`),
  )
  if (!validSignature) {
    return { _tag: "Rejected", reason: "invalid" }
  }

  const payloadBytes = base64UrlToBytes(payload)
  if (payloadBytes === null) {
    return { _tag: "Rejected", reason: "invalid" }
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(textDecoder.decode(payloadBytes))
  } catch {
    return { _tag: "Rejected", reason: "invalid" }
  }

  const claims = Option.getOrNull(
    Schema.decodeUnknownOption(FileCapabilityClaimsSchema, {
      onExcessProperty: "error",
    })(decoded),
  )
  if (claims === null) {
    return { _tag: "Rejected", reason: "invalid" }
  }
  if (claims.expiresAt <= input.now) {
    return { _tag: "Rejected", reason: "expired" }
  }
  if (claims.operation !== input.expectedOperation) {
    return { _tag: "Rejected", reason: "operation_mismatch" }
  }
  return { _tag: "Valid", claims }
}

/** Verify a signed capability, its absolute expiry, and its requested operation. */
export const verifyFileCapability = (input: {
  readonly token: string
  readonly signingSecret: Redacted.Redacted<string>
  readonly expectedOperation: FileCapabilityOperation
  readonly now: number
}): Effect.Effect<FileCapabilityClaims, InvalidFileCapability> =>
  Effect.tryPromise({
    try: () => verifyCapabilityDecision(input),
    catch: () => new InvalidFileCapability({ reason: "invalid" }),
  }).pipe(
    Effect.flatMap((decision) =>
      decision._tag === "Valid"
        ? Effect.succeed(decision.claims)
        : Effect.fail(new InvalidFileCapability({ reason: decision.reason })),
    ),
  )

const isFileContentType = Schema.is(FileContentTypeSchema)

const contentTypeOrNull = (
  value: string | undefined,
): FileContentType | null =>
  value !== undefined && isFileContentType(value) ? value : null

const digestOf = (object: R2ObjectPort): ContentDigest | null => {
  const sha256 = object.checksums?.sha256
  if (sha256 !== undefined && sha256.byteLength === 32) {
    return { _tag: "Sha256", value: hexOf(sha256) }
  }
  if (object.etag.length === 0 || object.etag.length > 512) {
    return null
  }
  return { _tag: "OpaqueEtag", value: object.etag }
}

const metadataFromObject = (
  object: R2ObjectPort,
): Effect.Effect<FileObjectMetadata, FileObjectStoreUnavailable> => {
  if (!isByteCount(object.size)) {
    return Effect.fail(
      new FileObjectStoreUnavailable({
        operation: "head",
        cause: new Error("Object storage returned an invalid byte count."),
      }),
    )
  }
  return Effect.succeed({
    size: object.size,
    contentType: contentTypeOrNull(object.httpMetadata?.contentType),
    digest: digestOf(object),
  })
}

const assertStrongSigningSecret = (
  secret: Redacted.Redacted<string>,
): void => {
  if (
    textEncoder.encode(Redacted.value(secret)).byteLength <
    MINIMUM_FILE_SIGNING_SECRET_BYTES
  ) {
    throw new Error(
      `The file capability signing secret must contain at least ${MINIMUM_FILE_SIGNING_SECRET_BYTES} UTF-8 bytes.`,
    )
  }
}

const normalizedCapabilityOrigin = (
  origin: URL,
  allowInsecureHttp: boolean,
): URL => {
  if (
    (origin.protocol !== "https:" &&
      !(allowInsecureHttp && origin.protocol === "http:")) ||
    origin.username.length > 0 ||
    origin.password.length > 0
  ) {
    throw new Error("The file capability origin must be an HTTP(S) origin.")
  }
  return new URL(origin.origin)
}

const checkedCapabilityPath = (value: string | undefined): string => {
  const path = value ?? defaultCapabilityPath
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/u.test(path) || path.includes("/../")) {
    throw new Error(
      "The file capability path must start and end with '/' and use URL-safe segments.",
    )
  }
  return path
}

const checkedKeyPrefix = (value: string | undefined): string => {
  const prefix = value ?? defaultKeyPrefix
  if (
    prefix.length === 0 ||
    prefix.length > maximumKeyPrefixLength ||
    prefix.startsWith("/") ||
    !prefix.endsWith("/") ||
    prefix.split("/").some((segment) => segment === "." || segment === "..") ||
    !/^[A-Za-z0-9._~/-]+$/u.test(prefix)
  ) {
    throw new Error(
      "The file object key prefix must be a relative, '/'-terminated R2 key prefix.",
    )
  }
  return prefix
}

const hexOf = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")

const checkedPositiveDuration = (
  name: string,
  value: number | undefined,
  fallback: number,
): number => {
  const duration = value ?? fallback
  if (
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    duration > MAX_FILE_CAPABILITY_TTL_MILLIS
  ) {
    throw new Error(`The ${name} must be a positive safe duration.`)
  }
  return duration
}

const checkedClockSkewAllowance = (value: number | undefined): number => {
  const duration = value ?? defaultClockSkewAllowanceMillis
  if (
    !Number.isSafeInteger(duration) ||
    duration < 0 ||
    duration > MAX_FILE_CAPABILITY_TTL_MILLIS
  ) {
    throw new Error(
      "The file capability clock-skew allowance must be a non-negative safe duration.",
    )
  }
  return duration
}

/** Construct one immutable timing policy shared by issuer and data plane. */
export const makeCloudflareFileCapabilityPolicy = (
  options: CloudflareFileCapabilityPolicyOptions = {},
): CloudflareFileCapabilityPolicy => {
  const uploadCapabilityTtlMillis = checkedPositiveDuration(
    "file upload capability TTL",
    options.uploadCapabilityTtlMillis,
    defaultUploadCapabilityTtlMillis,
  )
  const downloadCapabilityTtlMillis = checkedPositiveDuration(
    "file download capability TTL",
    options.downloadCapabilityTtlMillis,
    defaultDownloadCapabilityTtlMillis,
  )
  const maximumUploadDurationMillis = checkedPositiveDuration(
    "maximum file upload duration",
    options.maximumUploadDurationMillis,
    defaultMaximumUploadDurationMillis,
  )
  const clockSkewAllowanceMillis = checkedClockSkewAllowance(
    options.clockSkewAllowanceMillis,
  )
  const uploadReclamationGraceMillis =
    uploadCapabilityTtlMillis +
    maximumUploadDurationMillis +
    clockSkewAllowanceMillis
  const downloadReclamationGraceMillis =
    downloadCapabilityTtlMillis + clockSkewAllowanceMillis
  const reclamationGraceMillis = Math.max(
    uploadReclamationGraceMillis,
    downloadReclamationGraceMillis,
  )
  if (!Number.isSafeInteger(reclamationGraceMillis)) {
    throw new Error("The file reclamation grace duration is invalid.")
  }

  const policy: CloudflareFileCapabilityPolicy = {
    uploadCapabilityTtlMillis,
    downloadCapabilityTtlMillis,
    maximumUploadDurationMillis,
    clockSkewAllowanceMillis,
    reclamationGraceMillis,
    [validatedCapabilityPolicy]: true,
  }
  return Object.freeze(policy)
}

/** Safe default timing policy for ordinary Cloudflare deployments. */
export const DEFAULT_CLOUDFLARE_FILE_CAPABILITY_POLICY =
  makeCloudflareFileCapabilityPolicy()

const issueCapability = (
  claimsFor: (now: number) => Effect.Effect<
    FileCapabilityClaims,
    FileCapabilityUnavailable
  >,
  operation: "issue_upload" | "issue_download",
  capabilityBase: URL,
  signingSecret: Redacted.Redacted<string>,
) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      !isSafeTimestamp(now)
        ? Effect.fail(
            new FileCapabilityUnavailable({
              operation,
              cause: new Error("The capability clock returned an invalid value."),
            }),
          )
        : claimsFor(now).pipe(
            Effect.flatMap((claims) =>
              mintFileCapability(claims, signingSecret, now).pipe(
                Effect.map((token) => ({
                  url: CapabilityUrlSchema.make(
                    new URL(token, capabilityBase).href,
                  ),
                  expiresAt: claims.expiresAt,
                })),
              ),
            ),
            Effect.mapError(
              (cause) => new FileCapabilityUnavailable({ operation, cause }),
            ),
          ),
    ),
  )

/** Build the FileObjects implementation over an R2-compatible structural port. */
export const makeCloudflareFileObjects = (
  options: CloudflareFileObjectsOptions,
): FileObjectsService => {
  assertStrongSigningSecret(options.signingSecret)
  const capabilityBase = new URL(
    checkedCapabilityPath(options.capabilityPath),
    normalizedCapabilityOrigin(
      options.capabilityOrigin,
      options.allowInsecureHttp === true,
    ),
  )
  const keyPrefix = checkedKeyPrefix(options.keyPrefix)
  const policy = options.capabilityPolicy

  return FileObjects.of({
    uploadCapabilityTtlMillis: policy.uploadCapabilityTtlMillis,
    reclamationGraceMillis: policy.reclamationGraceMillis,
    locationFor: () =>
      FileObjectLocatorSchema.make(`${keyPrefix}${crypto.randomUUID()}`),
    stat: (locator) =>
      Effect.tryPromise({
        try: () => options.bucket.head(locator),
        catch: (cause) =>
          new FileObjectStoreUnavailable({ operation: "head", cause }),
      }).pipe(
        Effect.flatMap((object) =>
          object === null
            ? Effect.succeed(null)
            : metadataFromObject(object),
        ),
      ),
    issueUpload: ({ locator, maximumBytes, expiresAt, sha256, contentType }) =>
      issueCapability(
        (now) =>
          expiresAt <= now ||
          expiresAt > now + policy.uploadCapabilityTtlMillis
            ? Effect.fail(
                new FileCapabilityUnavailable({
                  operation: "issue_upload",
                  cause: new Error(
                    "The requested upload capability expiry is invalid.",
                  ),
                }),
              )
            : Effect.succeed({
                version: 2,
                operation: "put",
                locator,
                expiresAt,
                maximumBytes,
                sha256,
                contentType,
              }),
        "issue_upload",
        capabilityBase,
        options.signingSecret,
      ),
    issueDownload: ({ locator, fileName }) =>
      issueCapability(
        (now) => {
          const expiry = now + policy.downloadCapabilityTtlMillis
          if (!isSafeTimestamp(expiry)) {
            return Effect.fail(
              new FileCapabilityUnavailable({
                operation: "issue_download",
                cause: new Error(
                  "The capability clock returned an invalid value.",
                ),
              }),
            )
          }
          return Effect.succeed({
            version: 2,
            operation: "get",
            locator,
            expiresAt: TimestampMillisSchema.make(expiry),
            fileName,
          })
        },
        "issue_download",
        capabilityBase,
        options.signingSecret,
      ),
    put: ({ locator, body, contentType, sha256 }) =>
      Effect.tryPromise({
        try: () =>
          options.bucket.put(locator, new Blob([body]).stream(), {
            httpMetadata:
              contentType === null ? {} : { contentType },
            onlyIf: { etagDoesNotMatch: "*" },
            sha256,
          }),
        catch: (cause) =>
          new FileObjectStoreUnavailable({ operation: "put", cause }),
      }).pipe(Effect.asVoid),
    get: (locator) =>
      Effect.tryPromise({
        try: () => options.bucket.get(locator),
        catch: (cause) =>
          new FileObjectStoreUnavailable({ operation: "get", cause }),
      }).pipe(Effect.map((object) => object?.body ?? null)),
    delete: (locator) =>
      Effect.tryPromise({
        try: () => options.bucket.delete(locator),
        catch: (cause) =>
          new FileObjectStoreUnavailable({ operation: "delete", cause }),
      }),
  })
}

/** Build a Layer providing FileObjects through the Cloudflare integration. */
export const cloudflareFileObjectsLayer = (
  options: CloudflareFileObjectsOptions,
): Layer.Layer<FileObjects> =>
  Layer.succeed(FileObjects, makeCloudflareFileObjects(options))

class CapacityExceededError extends Error {
  constructor() {
    super("Upload exceeds its capability byte limit.")
    this.name = "CapacityExceededError"
  }
}

class UploadDeadlineExceededError extends Error {
  constructor() {
    super("Upload exceeded its capability deadline.")
    this.name = "UploadDeadlineExceededError"
  }
}

const meteredBody = (
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> => {
  let total = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        if (chunk.byteLength > maximumBytes - total) {
          controller.error(new CapacityExceededError())
          return
        }
        total += chunk.byteLength
        controller.enqueue(chunk)
      },
    }),
    { signal },
  )
}

const isCapacityExceededError = (cause: unknown): boolean =>
  cause instanceof CapacityExceededError ||
  (cause instanceof Error && cause.name === "CapacityExceededError")

const isUploadDeadlineExceededError = (cause: unknown): boolean =>
  cause instanceof UploadDeadlineExceededError ||
  (cause instanceof Error && cause.name === "UploadDeadlineExceededError")

interface FixedLengthStreamPort {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
}

interface FixedLengthStreamConstructorPort {
  new (expectedLength: number): FixedLengthStreamPort
}

const platformFixedLengthStream =
  (): FixedLengthStreamConstructorPort | null => {
    const candidate: unknown = Reflect.get(globalThis, "FixedLengthStream")
    if (typeof candidate !== "function") {
      return null
    }
    // SAFETY: Cloudflare exposes this exact global constructor. Its result is
    // consumed only through the narrow readable/writable stream contract.
    return candidate as FixedLengthStreamConstructorPort
  }

interface PreparedUploadBody {
  readonly body: ReadableStream<Uint8Array> | null
  readonly transfer: Promise<TransferOutcome> | null
}

type TransferOutcome =
  | { readonly _tag: "Completed" }
  | { readonly _tag: "Failed"; readonly cause: unknown }

const prepareUploadBody = (
  body: ReadableStream<Uint8Array> | null,
  declaredLength: number,
  maximumBytes: number,
  signal: AbortSignal,
): PreparedUploadBody => {
  if (body === null) {
    return { body: null, transfer: null }
  }

  const metered = meteredBody(body, maximumBytes, signal)
  const FixedLengthStream = platformFixedLengthStream()
  if (FixedLengthStream === null) {
    return { body: metered, transfer: null }
  }

  const fixedLength = new FixedLengthStream(declaredLength)
  const transfer = metered
    .pipeTo(fixedLength.writable, { signal })
    .then(
      (): TransferOutcome => ({ _tag: "Completed" }),
      (cause: unknown): TransferOutcome => ({ _tag: "Failed", cause }),
    )
  return {
    body: fixedLength.readable,
    transfer,
  }
}

interface UploadDeadlineOutcome {
  readonly _tag: "Expired"
}

interface UploadRequestAbortedOutcome {
  readonly _tag: "Aborted"
}

interface UploadDeadline {
  readonly reached: Promise<UploadDeadlineOutcome>
  readonly expired: () => boolean
  readonly cancel: () => void
}

const makeUploadDeadline = (
  durationMillis: number,
  onExpire: () => void,
): UploadDeadline => {
  let didExpire = false
  let didSettle = false
  let resolveOutcome: (outcome: UploadDeadlineOutcome) => void = () => undefined
  const reached = new Promise<UploadDeadlineOutcome>((resolve) => {
    resolveOutcome = resolve
  })
  const timer = globalThis.setTimeout(() => {
    if (didSettle) return
    didSettle = true
    didExpire = true
    onExpire()
    resolveOutcome({ _tag: "Expired" })
  }, durationMillis)

  return {
    reached,
    expired: () => didExpire,
    cancel: () => {
      if (didSettle) return
      didSettle = true
      globalThis.clearTimeout(timer)
    },
  }
}

type CorsDecision =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Allowed"; readonly origin: string }
  | { readonly _tag: "Rejected" }

const parseOrigin = (value: string): string | null => {
  try {
    const origin = new URL(value).origin
    return origin === "null" ? null : origin
  } catch {
    return null
  }
}

const corsDecision = (
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): CorsDecision => {
  const rawOrigin = request.headers.get("origin")
  if (rawOrigin === null) {
    return { _tag: "Absent" }
  }
  const origin = parseOrigin(rawOrigin)
  if (origin === null) {
    return { _tag: "Rejected" }
  }
  if (origin === new URL(request.url).origin || allowedOrigins.has(origin)) {
    return { _tag: "Allowed", origin }
  }
  return { _tag: "Rejected" }
}

const responseHeaders = (
  cors: CorsDecision,
  initial?: HeadersInit,
): Headers => {
  const headers = new Headers(initial)
  headers.set("Cache-Control", "no-store")
  headers.set("Referrer-Policy", "no-referrer")
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox")
  if (cors._tag === "Allowed") {
    headers.set("Access-Control-Allow-Origin", cors.origin)
    headers.set("Access-Control-Expose-Headers", objectCorsExposeHeadersHeader)
    const vary = headers.get("Vary")
    if (vary === null) {
      headers.set("Vary", "Origin")
    } else if (
      !vary
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .includes("origin")
    ) {
      headers.set("Vary", `${vary}, Origin`)
    }
  }
  return headers
}

const emptyResponse = (
  status: number,
  cors: CorsDecision,
  initial?: HeadersInit,
): Response =>
  new Response(null, {
    status,
    headers: responseHeaders(cors, initial),
  })

const preflightResponse = (
  request: Request,
  cors: CorsDecision,
): Response => {
  if (cors._tag !== "Allowed") {
    return emptyResponse(403, { _tag: "Absent" })
  }
  const requestedMethod = request.headers
    .get("access-control-request-method")
    ?.toUpperCase()
  const headers = responseHeaders(cors, {
    "Access-Control-Allow-Methods": objectCorsMethodsHeader,
    "Access-Control-Allow-Headers": objectCorsRequestHeadersHeader,
    "Access-Control-Max-Age": "600",
    Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  })
  if (requestedMethod !== "GET" && requestedMethod !== "PUT") {
    return new Response(null, { status: 405, headers })
  }
  return new Response(null, { status: 204, headers })
}

const capabilityTokenFromRequest = (
  request: Request,
  capabilityPath: string,
): string | null => {
  const path = new URL(request.url).pathname
  if (!path.startsWith(capabilityPath)) {
    return null
  }
  const token = path.slice(capabilityPath.length)
  return token.length > 0 && !token.includes("/") ? token : null
}

type CapabilityGate =
  | { readonly _tag: "Allowed"; readonly claims: FileCapabilityClaims }
  | {
      readonly _tag: "Rejected"
      readonly reason: "expired" | "invalid" | "operation_mismatch"
    }

const gateCapability = (
  token: string,
  expectedOperation: FileCapabilityOperation,
  options: CloudflareFileDataPlaneOptions,
  now: number,
): Promise<CapabilityGate> =>
  Effect.runPromise(
    verifyFileCapability({
      token,
      signingSecret: options.signingSecret,
      expectedOperation,
      now,
    }).pipe(
      Effect.match({
        onFailure: (error): CapabilityGate => ({
          _tag: "Rejected",
          reason: error.reason,
        }),
        onSuccess: (claims): CapabilityGate => ({
          _tag: "Allowed",
          claims,
        }),
      }),
    ),
  )

const declaredContentLength = (
  request: Request,
): number | "invalid" | null => {
  const value = request.headers.get("content-length")
  if (value === null) {
    return null
  }
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    return "invalid"
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : "invalid"
}

const uploadContentType = (request: Request): FileContentType =>
  contentTypeOrNull(request.headers.get("content-type") ?? undefined) ??
  FileContentTypeSchema.make("application/octet-stream")

// R2 reports a digest mismatch only through its error text (code 10037,
// "BadDigest"); nothing was stored, so the client must not retry as if the
// store were unavailable.
const isDigestMismatchError = (cause: unknown): boolean =>
  cause instanceof Error &&
  /\b10037\b|BadDigest|checksum|digest/iu.test(cause.message)

const uploadFailureStatus = (
  request: Request,
  deadline: UploadDeadline,
  cause: unknown,
  expectsDigest: boolean,
): number =>
  request.signal.aborted
    ? 499
    : deadline.expired() || isUploadDeadlineExceededError(cause)
      ? 408
      : isCapacityExceededError(cause)
        ? 413
        : expectsDigest && isDigestMismatchError(cause)
          ? 400
          : 503

const etagHeader = (object: R2ObjectPort): string | null => {
  if (
    object.httpEtag !== undefined &&
    /^(W\/)?"[\x21\x23-\x7e]*"$/u.test(object.httpEtag)
  ) {
    return object.httpEtag
  }
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,512}$/u.test(object.etag)
    ? `"${object.etag}"`
    : null
}

const encodedAttachmentName = (fileName: FileName): string =>
  encodeURIComponent(fileName).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )

const attachmentHeader = (fileName: FileName): string => {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/gu, "_")
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodedAttachmentName(
    fileName,
  )}`
}

const handleUpload = async (
  request: Request,
  token: string,
  cors: CorsDecision,
  options: CloudflareFileDataPlaneOptions,
): Promise<Response> => {
  const startedAt = (options.now ?? Date.now)()
  const gate = await gateCapability(token, "put", options, startedAt)
  if (gate._tag === "Rejected") {
    return emptyResponse(
      gate.reason === "operation_mismatch" ? 403 : 401,
      cors,
    )
  }
  if (gate.claims.operation !== "put") {
    return emptyResponse(403, cors)
  }
  const expectsDigest = gate.claims.sha256 !== null

  const declared = declaredContentLength(request)
  if (declared === "invalid") {
    return emptyResponse(400, cors)
  }
  if (declared !== null && declared > gate.claims.maximumBytes) {
    return emptyResponse(413, cors)
  }
  if (request.body !== null && declared === null) {
    return emptyResponse(411, cors)
  }
  if (request.body === null && declared !== null && declared > 0) {
    return emptyResponse(400, cors)
  }

  const transferAbort = new AbortController()
  let resolveRequestAborted: (
    outcome: UploadRequestAbortedOutcome,
  ) => void = () => undefined
  const requestAborted = new Promise<UploadRequestAbortedOutcome>((resolve) => {
    resolveRequestAborted = resolve
  })
  const abortFromRequest = () => {
    transferAbort.abort(request.signal.reason)
    resolveRequestAborted({ _tag: "Aborted" })
  }
  let requestAbortListenerAttached = false
  if (request.signal.aborted) {
    abortFromRequest()
  } else {
    request.signal.addEventListener("abort", abortFromRequest, { once: true })
    requestAbortListenerAttached = true
  }
  const deadlineDuration = Math.min(
    gate.claims.expiresAt - startedAt,
    options.capabilityPolicy.maximumUploadDurationMillis,
  )
  const deadline = makeUploadDeadline(deadlineDuration, () => {
    transferAbort.abort(new UploadDeadlineExceededError())
  })

  try {
    const prepared = prepareUploadBody(
      request.body,
      declared ?? 0,
      gate.claims.maximumBytes,
      transferAbort.signal,
    )
    const storing = Promise.resolve()
      .then(() => {
        request.signal.throwIfAborted()
        const claims = gate.claims
        const contentType =
          claims.operation === "put" && claims.contentType !== null
            ? claims.contentType
            : uploadContentType(request)
        return options.bucket.put(claims.locator, prepared.body, {
          httpMetadata: { contentType },
          onlyIf: { etagDoesNotMatch: "*" },
          ...(claims.operation === "put" && claims.sha256 !== null
            ? { sha256: claims.sha256 }
            : {}),
        })
      })
      .then(
        (stored) => ({ _tag: "Stored", stored }) as const,
        (cause: unknown) => ({ _tag: "Failed", cause }) as const,
      )
    const first = await Promise.race([
      storing,
      deadline.reached,
      requestAborted,
    ])
    if (first._tag === "Aborted") {
      return emptyResponse(499, cors)
    }
    if (first._tag === "Expired") {
      if (prepared.transfer !== null) {
        await prepared.transfer
      }
      return emptyResponse(request.signal.aborted ? 499 : 408, cors)
    }
    if (first._tag === "Failed") {
      transferAbort.abort()
      const transferred =
        prepared.transfer === null ? null : await prepared.transfer
      const classifiedCause =
        transferred?._tag === "Failed" &&
        isCapacityExceededError(transferred.cause)
          ? transferred.cause
          : first.cause
      return emptyResponse(
        uploadFailureStatus(request, deadline, classifiedCause, expectsDigest),
        cors,
      )
    }
    if (first.stored === null) {
      transferAbort.abort()
      if (prepared.transfer !== null) {
        await prepared.transfer
      }
      return emptyResponse(204, cors)
    }
    if (prepared.transfer === null) {
      return emptyResponse(204, cors)
    }
    const transferred = await prepared.transfer
    if (transferred._tag === "Failed") {
      return emptyResponse(
        uploadFailureStatus(
          request,
          deadline,
          transferred.cause,
          expectsDigest,
        ),
        cors,
      )
    }
    return emptyResponse(204, cors)
  } catch (cause: unknown) {
    return emptyResponse(
      uploadFailureStatus(request, deadline, cause, expectsDigest),
      cors,
    )
  } finally {
    if (requestAbortListenerAttached) {
      request.signal.removeEventListener("abort", abortFromRequest)
    }
    deadline.cancel()
    transferAbort.abort()
  }
}

const handleDownload = async (
  token: string,
  cors: CorsDecision,
  options: CloudflareFileDataPlaneOptions,
): Promise<Response> => {
  const gate = await gateCapability(
    token,
    "get",
    options,
    (options.now ?? Date.now)(),
  )
  if (gate._tag === "Rejected") {
    return emptyResponse(
      gate.reason === "operation_mismatch" ? 403 : 401,
      cors,
    )
  }
  if (gate.claims.operation !== "get") {
    return emptyResponse(403, cors)
  }

  let object: R2ObjectBodyPort | null
  try {
    object = await options.bucket.get(gate.claims.locator)
  } catch {
    return emptyResponse(503, cors)
  }
  if (object === null) {
    return emptyResponse(404, cors)
  }
  if (!isByteCount(object.size)) {
    return emptyResponse(503, cors)
  }

  const headers = responseHeaders(cors, {
    "Content-Type":
      contentTypeOrNull(object.httpMetadata?.contentType) ??
      "application/octet-stream",
    "Content-Length": String(object.size),
    "Content-Disposition": attachmentHeader(gate.claims.fileName),
  })
  const etag = etagHeader(object)
  if (etag !== null) {
    headers.set("ETag", etag)
  }
  return new Response(object.body, { status: 200, headers })
}

/**
 * Build the standard Fetch data plane for signed R2 PUT/GET capabilities.
 *
 * Non-empty PUT requests require a valid `Content-Length`. Cloudflare sets it
 * automatically for fixed-size bodies and `FixedLengthStream`; arbitrary
 * unknown-length streams are rejected with HTTP 411 before R2 is called.
 */
export const makeCloudflareFileDataPlaneHandler = (
  options: CloudflareFileDataPlaneOptions,
): CloudflareFileDataPlaneHandler => {
  assertStrongSigningSecret(options.signingSecret)
  const capabilityPath = checkedCapabilityPath(options.capabilityPath)
  const allowedOrigins = new Set<string>()
  for (const configured of options.allowedOrigins ?? []) {
    const origin = parseOrigin(configured)
    if (origin !== null) {
      allowedOrigins.add(origin)
    }
  }

  const allowInsecureHttp = options.allowInsecureHttp === true
  return async (request) => {
    const protocol = new URL(request.url).protocol
    if (
      protocol !== "https:" &&
      !(allowInsecureHttp && protocol === "http:")
    ) {
      return emptyResponse(400, { _tag: "Absent" })
    }
    const token = capabilityTokenFromRequest(request, capabilityPath)
    if (token === null) {
      return emptyResponse(404, { _tag: "Absent" })
    }
    const cors = corsDecision(request, allowedOrigins)
    if (request.method === "OPTIONS") {
      return preflightResponse(request, cors)
    }
    if (cors._tag === "Rejected") {
      return emptyResponse(403, { _tag: "Absent" })
    }
    if (request.method === "PUT") {
      return handleUpload(request, token, cors, options)
    }
    if (request.method === "GET") {
      return handleDownload(token, cors, options)
    }
    return emptyResponse(405, cors, { Allow: objectCorsMethodsHeader })
  }
}
