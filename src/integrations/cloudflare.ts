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
  TimestampMillisSchema,
  type FileName,
  type FileContentType,
} from "../file.js"

const capabilityTokenVersion = "v1"
const maximumCapabilityTokenLength = 4096
const defaultUploadCapabilityTtlMillis = 60_000
const defaultDownloadCapabilityTtlMillis = 300_000
const defaultMaximumUploadDurationMillis = 300_000
const defaultClockSkewAllowanceMillis = 30_000
const objectRoutePrefix = "/o/"
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

/** Object metadata returned by the structural R2 port. */
export interface R2ObjectPort {
  readonly size: number
  readonly etag: string
  readonly httpEtag?: string
  readonly httpMetadata?: R2HttpMetadataPort
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
    },
  ) => PromiseLike<R2PutResultPort | null>
  /** Idempotently remove one object; deleting an absent key succeeds. */
  readonly delete: (key: string) => PromiseLike<void>
}

/** Operation authorized by one file data-plane capability. */
export type FileCapabilityOperation = "get" | "put"

/** Runtime schema for a version-one bounded upload capability. */
export const UploadFileCapabilityClaimsSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation: Schema.Literal("put"),
  locator: FileObjectLocatorSchema,
  expiresAt: TimestampMillisSchema,
  maximumBytes: ByteCountSchema,
})

/** Signed claim granting one bounded direct upload. */
export type UploadFileCapabilityClaims = Schema.Schema.Type<
  typeof UploadFileCapabilityClaimsSchema
>

/** Runtime schema for a version-one attachment download capability. */
export const DownloadFileCapabilityClaimsSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation: Schema.Literal("get"),
  locator: FileObjectLocatorSchema,
  expiresAt: TimestampMillisSchema,
  fileName: FileNameSchema,
})

/** Signed claim granting one attachment download. */
export type DownloadFileCapabilityClaims = Schema.Schema.Type<
  typeof DownloadFileCapabilityClaimsSchema
>

/** Runtime schema for the strict version-one capability union. */
export const FileCapabilityClaimsSchema = Schema.Union([
  UploadFileCapabilityClaimsSchema,
  DownloadFileCapabilityClaimsSchema,
])

/** Strict version-one file capability claim union. */
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
  /** Explicit development escape hatch for an HTTP capability origin. */
  readonly allowInsecureHttp?: boolean
}

/** Configuration for the cookieless Fetch data-plane handler. */
export interface CloudflareFileDataPlaneOptions {
  readonly bucket: R2BucketPort
  readonly signingSecret: Redacted.Redacted<string>
  readonly capabilityPolicy: CloudflareFileCapabilityPolicy
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

const opaqueEtagOrNull = (
  value: string,
): FileObjectMetadata["digest"] => {
  if (value.length === 0 || value.length > 512) {
    return null
  }
  return { _tag: "OpaqueEtag", value }
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
    digest: opaqueEtagOrNull(object.etag),
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
  capabilityOrigin: URL,
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
                    new URL(`${objectRoutePrefix}${token}`, capabilityOrigin)
                      .href,
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
  const capabilityOrigin = normalizedCapabilityOrigin(
    options.capabilityOrigin,
    options.allowInsecureHttp === true,
  )
  const policy = options.capabilityPolicy

  return FileObjects.of({
    uploadCapabilityTtlMillis: policy.uploadCapabilityTtlMillis,
    reclamationGraceMillis: policy.reclamationGraceMillis,
    locationFor: () =>
      FileObjectLocatorSchema.make(
        `files/v1/${crypto.randomUUID()}`,
      ),
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
    issueUpload: ({ locator, maximumBytes, expiresAt }) =>
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
                version: 1,
                operation: "put",
                locator,
                expiresAt,
                maximumBytes,
              }),
        "issue_upload",
        capabilityOrigin,
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
            version: 1,
            operation: "get",
            locator,
            expiresAt: TimestampMillisSchema.make(expiry),
            fileName,
          })
        },
        "issue_download",
        capabilityOrigin,
        options.signingSecret,
      ),
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

const capabilityTokenFromRequest = (request: Request): string | null => {
  const path = new URL(request.url).pathname
  if (!path.startsWith(objectRoutePrefix)) {
    return null
  }
  const token = path.slice(objectRoutePrefix.length)
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

const uploadFailureStatus = (
  request: Request,
  deadline: UploadDeadline,
  cause: unknown,
): number =>
  request.signal.aborted
    ? 499
    : deadline.expired() || isUploadDeadlineExceededError(cause)
      ? 408
      : isCapacityExceededError(cause)
        ? 413
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
        return options.bucket.put(gate.claims.locator, prepared.body, {
          httpMetadata: { contentType: uploadContentType(request) },
          onlyIf: { etagDoesNotMatch: "*" },
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
        uploadFailureStatus(request, deadline, classifiedCause),
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
        uploadFailureStatus(request, deadline, transferred.cause),
        cors,
      )
    }
    return emptyResponse(204, cors)
  } catch (cause: unknown) {
    return emptyResponse(
      uploadFailureStatus(request, deadline, cause),
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
    const token = capabilityTokenFromRequest(request)
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
