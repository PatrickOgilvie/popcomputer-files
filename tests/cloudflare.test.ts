import { describe, expect, test } from "vitest"
import { Effect, Redacted } from "effect"
import {
  FileObjectLocatorSchema,
} from "../src/adapter.js"
import {
  ByteCountSchema,
  FileIdSchema,
  FileNameSchema,
  FileSystemIdSchema,
  TimestampMillisSchema,
} from "../src/file.js"
import {
  DEFAULT_CLOUDFLARE_FILE_CAPABILITY_POLICY,
  makeCloudflareFileDataPlaneHandler,
  makeCloudflareFileCapabilityPolicy,
  makeCloudflareFileObjects,
  mintFileCapability,
  verifyFileCapability,
  type FileCapabilityClaims,
  type R2BucketPort,
  type R2ObjectBodyPort,
} from "../src/integrations/cloudflare.js"

const now = 2_000_000_000_000
const signingSecret = Redacted.make(
  "a-high-entropy-test-signing-secret-with-32-bytes",
)
const capabilityPolicy = DEFAULT_CLOUDFLARE_FILE_CAPABILITY_POLICY
const locator = FileObjectLocatorSchema.make(
  "files/v1/account/workspace/file-1",
)
const fileName = FileNameSchema.make("report.html")

const makeBucket = (
  overrides: Partial<R2BucketPort> = {},
): R2BucketPort => ({
  head: overrides.head ?? (async () => null),
  get: overrides.get ?? (async () => null),
  put: overrides.put ?? (async () => ({ etag: "put-etag" })),
  delete: overrides.delete ?? (async () => undefined),
})

const uploadClaims = (
  maximumBytes = 4,
  expiresAt = now + 60_000,
): FileCapabilityClaims => ({
  version: 1,
  operation: "put",
  locator,
  expiresAt: TimestampMillisSchema.make(expiresAt),
  maximumBytes: ByteCountSchema.make(maximumBytes),
})

const downloadClaims = (
  expiresAt = now + 60_000,
): FileCapabilityClaims => ({
  version: 1,
  operation: "get",
  locator,
  expiresAt: TimestampMillisSchema.make(expiresAt),
  fileName,
})

const mint = (claims: FileCapabilityClaims): Promise<string> =>
  Effect.runPromise(mintFileCapability(claims, signingSecret, now))

const tokenRequest = (
  token: string,
  init?: RequestInit,
): Request => new Request(`https://files.example.com/o/${token}`, init)

const uploadRequest = (
  token: string,
  body: BodyInit,
  declaredLength: number,
): Request =>
  tokenRequest(token, {
    method: "PUT",
    body,
    headers: { "Content-Length": String(declaredLength) },
  })

const bytesStream = (text: string): ReadableStream<Uint8Array> =>
  new Blob([text]).stream()

const stalledUploadRequest = (
  token: string,
  declaredLength: number,
): Request => {
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new Uint8Array([1]))
    },
  })
  const init: RequestInit & { readonly duplex: "half" } = {
    method: "PUT",
    body,
    duplex: "half",
    headers: { "Content-Length": String(declaredLength) },
  }
  return tokenRequest(token, init)
}

const streamText = async (
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> => {
  if (stream === null) {
    return ""
  }
  const reader = stream.getReader()
  const chunks: Array<Uint8Array> = []
  for (;;) {
    const next = await reader.read()
    if (next.done) {
      break
    }
    chunks.push(next.value)
  }
  const size = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  )
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

const promptly = async <A>(promise: Promise<A>, operation: string): Promise<A> => {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(
      () => reject(new Error(`${operation} did not settle promptly.`)),
      250,
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer)
    }
  }
}

describe("Cloudflare file capabilities", () => {
  test("constructs one immutable timing policy and derives reclamation grace", () => {
    const policy = makeCloudflareFileCapabilityPolicy({
      uploadCapabilityTtlMillis: 100,
      downloadCapabilityTtlMillis: 200,
      maximumUploadDurationMillis: 300,
      clockSkewAllowanceMillis: 40,
    })

    expect(policy.reclamationGraceMillis).toBe(440)
    expect(Object.isFrozen(policy)).toBe(true)

    const downloadDominatedPolicy = makeCloudflareFileCapabilityPolicy({
      uploadCapabilityTtlMillis: 100,
      downloadCapabilityTtlMillis: 800,
      maximumUploadDurationMillis: 300,
      clockSkewAllowanceMillis: 40,
    })
    expect(downloadDominatedPolicy.reclamationGraceMillis).toBe(840)

    expect(() =>
      makeCloudflareFileCapabilityPolicy({
        maximumUploadDurationMillis: 0,
      }),
    ).toThrow(/positive safe duration/u)
    expect(() =>
      makeCloudflareFileCapabilityPolicy({
        clockSkewAllowanceMillis: -1,
      }),
    ).toThrow(/non-negative safe duration/u)
  })

  test("rejects a tampered signed payload", async () => {
    const token = await mint(downloadClaims())
    const payloadStart = token.indexOf(".") + 1
    const replacement = token[payloadStart] === "A" ? "B" : "A"
    const tampered =
      token.slice(0, payloadStart) +
      replacement +
      token.slice(payloadStart + 1)

    const outcome = await Effect.runPromise(
      Effect.result(
        verifyFileCapability({
          token: tampered,
          signingSecret,
          expectedOperation: "get",
          now,
        }),
      ),
    )

    expect(outcome._tag).toBe("Failure")
  })

  test("distinguishes expiry and operation mismatch while failing closed", async () => {
    const expiredToken = await mint(downloadClaims(now + 1))
    const uploadToken = await mint(uploadClaims())
    const handler = makeCloudflareFileDataPlaneHandler({
      bucket: makeBucket(),
      signingSecret,
      capabilityPolicy,
      now: () => now + 1,
    })

    const expired = await handler(tokenRequest(expiredToken))
    const wrongOperation = await handler(tokenRequest(uploadToken))

    expect(expired.status).toBe(401)
    expect(wrongOperation.status).toBe(403)
  })
})

describe("Cloudflare file data plane", () => {
  test.each([
    {
      name: "maximum upload duration",
      policy: makeCloudflareFileCapabilityPolicy({
        uploadCapabilityTtlMillis: 1_000,
        downloadCapabilityTtlMillis: 1_000,
        maximumUploadDurationMillis: 10,
        clockSkewAllowanceMillis: 0,
      }),
      expiresAt: now + 1_000,
    },
    {
      name: "capability expiry",
      policy: makeCloudflareFileCapabilityPolicy({
        uploadCapabilityTtlMillis: 1_000,
        downloadCapabilityTtlMillis: 1_000,
        maximumUploadDurationMillis: 1_000,
        clockSkewAllowanceMillis: 0,
      }),
      expiresAt: now + 10,
    },
  ])("aborts a stalled stream at the earlier $name", async (fixture) => {
    const bucket = makeBucket({
      put: async (_key, body) => {
        await streamText(body)
        return { etag: "put-etag" }
      },
    })
    const token = await mint(uploadClaims(4, fixture.expiresAt))
    const handler = makeCloudflareFileDataPlaneHandler({
      bucket,
      signingSecret,
      capabilityPolicy: fixture.policy,
      now: () => now,
    })

    const response = await handler(stalledUploadRequest(token, 2))

    expect(response.status).toBe(408)
  })

  test("cancels a stalled upload promptly when its request is aborted", async () => {
    let resolvePutStarted: () => void = () => undefined
    const putStarted = new Promise<void>((resolve) => {
      resolvePutStarted = resolve
    })
    let rejectPut: (cause: unknown) => void = () => undefined
    const pendingPut = new Promise<never>((_resolve, reject) => {
      rejectPut = reject
    })
    const bucket = makeBucket({
      put: async (_key, uploadBody) => {
        if (uploadBody === null) {
          throw new Error("expected an upload body")
        }
        const reader = uploadBody.getReader()
        await reader.read()
        resolvePutStarted()
        return await pendingPut
      },
    })
    const token = await mint(uploadClaims(4))
    const handler = makeCloudflareFileDataPlaneHandler({
      bucket,
      signingSecret,
      capabilityPolicy,
      now: () => now,
    })
    let resolveBodyCancelled: () => void = () => undefined
    const bodyCancelled = new Promise<void>((resolve) => {
      resolveBodyCancelled = resolve
    })
    let emitted = false
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (!emitted) {
          emitted = true
          controller.enqueue(new Uint8Array([1]))
          return
        }
      },
      cancel: () => {
        resolveBodyCancelled()
      },
    })
    const abort = new AbortController()
    const requestInit: RequestInit & { readonly duplex: "half" } = {
      method: "PUT",
      body,
      duplex: "half",
      headers: { "Content-Length": "2" },
      signal: abort.signal,
    }
    const request = tokenRequest(token, requestInit)

    const responsePromise = handler(request)
    await promptly(putStarted, "R2 upload start")
    abort.abort(new DOMException("Upload cancelled.", "AbortError"))

    const response = await promptly(responsePromise, "aborted upload handler")
    expect(response.status).toBe(499)
    await promptly(bodyCancelled, "aborted upload body")

    rejectPut(new Error("late object-store failure"))
    await Promise.resolve()
  })

  test("does not start object storage for a pre-aborted upload", async () => {
    let putCalled = false
    const bucket = makeBucket({
      put: async () => {
        putCalled = true
        return { etag: "put-etag" }
      },
    })
    const token = await mint(uploadClaims(4))
    const handler = makeCloudflareFileDataPlaneHandler({
      bucket,
      signingSecret,
      capabilityPolicy,
      now: () => now,
    })
    const abort = new AbortController()
    abort.abort(new DOMException("Upload cancelled.", "AbortError"))

    const response = await handler(
      tokenRequest(token, {
        method: "PUT",
        body: "data",
        headers: { "Content-Length": "4" },
        signal: abort.signal,
      }),
    )

    expect(response.status).toBe(499)
    expect(putCalled).toBe(false)
  })

  test("enforces the signed byte cap against streamed bytes", async () => {
    const bucket = makeBucket({
      put: async (_key, body) => {
        await streamText(body)
        return { etag: "put-etag" }
      },
    })
    const token = await mint(uploadClaims(4))
    const handler = makeCloudflareFileDataPlaneHandler({
      bucket,
      signingSecret,
      capabilityPolicy,
      now: () => now,
    })

    const response = await handler(
      uploadRequest(token, "too large", 4),
    )

    expect(response.status).toBe(413)
  })

  test("requires a known upload length without consuming the body", async () => {
    let putCalled = false
    const bucket = makeBucket({
      put: async () => {
        putCalled = true
        return { etag: "put-etag" }
      },
    })
    const token = await mint(uploadClaims(20))
    const handler = makeCloudflareFileDataPlaneHandler({
      bucket,
      signingSecret,
      capabilityPolicy,
      now: () => now,
    })

    const response = await handler(
      tokenRequest(token, { method: "PUT", body: "unknown" }),
    )

    expect(response.status).toBe(411)
    expect(putCalled).toBe(false)
  })

  test("rejects a positive declared length without a body", async () => {
    let putCalled = false
    const bucket = makeBucket({
      put: async () => {
        putCalled = true
        return { etag: "put-etag" }
      },
    })
    const token = await mint(uploadClaims(20))
    const handler = makeCloudflareFileDataPlaneHandler({
      bucket,
      signingSecret,
      capabilityPolicy,
      now: () => now,
    })

    const response = await handler(
      tokenRequest(token, {
        method: "PUT",
        headers: { "Content-Length": "5" },
      }),
    )

    expect(response.status).toBe(400)
    expect(putCalled).toBe(false)
  })

  test("makes upload capabilities write-once with an object precondition", async () => {
    let stored: string | null = null
    const bucket = makeBucket({
      put: async (_key, body, options) => {
        expect(options.onlyIf).toEqual({ etagDoesNotMatch: "*" })
        if (stored !== null) return null
        stored = await streamText(body)
        return { etag: "put-etag" }
      },
    })
    const token = await mint(uploadClaims(20))
    const handler = makeCloudflareFileDataPlaneHandler({
      bucket,
      signingSecret,
      capabilityPolicy,
      now: () => now,
    })

    const first = await handler(
      uploadRequest(token, "first", 5),
    )
    const second = await handler(
      uploadRequest(token, "second", 6),
    )

    expect(first.status).toBe(204)
    expect(second.status).toBe(204)
    expect(stored).toBe("first")
  })

  test("serves downloads with attachment and defensive headers", async () => {
    const object: R2ObjectBodyPort = {
      size: 5,
      etag: "abc123",
      httpMetadata: { contentType: "text/html" },
      body: bytesStream("hello"),
    }
    const bucket = makeBucket({ get: async () => object })
    const token = await mint(downloadClaims())
    const handler = makeCloudflareFileDataPlaneHandler({
      bucket,
      signingSecret,
      capabilityPolicy,
      now: () => now,
    })

    const response = await handler(tokenRequest(token))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("hello")
    expect(response.headers.get("Content-Type")).toBe("text/html")
    expect(response.headers.get("Content-Length")).toBe("5")
    expect(response.headers.get("ETag")).toBe('"abc123"')
    expect(response.headers.get("Content-Disposition")).toContain(
      "attachment",
    )
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer")
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    )
  })

  test("answers allowed preflights and rejects other origins", async () => {
    const token = await mint(uploadClaims())
    const handler = makeCloudflareFileDataPlaneHandler({
      bucket: makeBucket(),
      signingSecret,
      capabilityPolicy,
      allowedOrigins: ["https://app.example.com"],
      now: () => now,
    })
    const preflight = (origin: string) =>
      handler(
        tokenRequest(token, {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": "PUT",
          },
        }),
      )

    const allowed = await preflight("https://app.example.com")
    const rejected = await preflight("https://other.example.com")

    expect(allowed.status).toBe(204)
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    )
    expect(allowed.headers.get("Access-Control-Allow-Methods")).toContain(
      "PUT",
    )
    expect(allowed.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type",
    )
    expect(allowed.headers.get("Vary")).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    )
    expect(rejected.status).toBe(403)
    expect(rejected.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  test("rejects cleartext requests unless explicitly enabled", async () => {
    let reads = 0
    const bucket = makeBucket({
      get: async () => {
        reads += 1
        return null
      },
    })
    const token = await mint(downloadClaims())
    const secureHandler = makeCloudflareFileDataPlaneHandler({
      bucket,
      signingSecret,
      capabilityPolicy,
      now: () => now,
    })
    const developmentHandler = makeCloudflareFileDataPlaneHandler({
      bucket,
      signingSecret,
      capabilityPolicy,
      allowInsecureHttp: true,
      now: () => now,
    })
    const request = () =>
      new Request(`http://files.example.com/o/${token}`)

    const rejected = await secureHandler(request())
    const allowed = await developmentHandler(request())

    expect(rejected.status).toBe(400)
    expect(allowed.status).toBe(404)
    expect(reads).toBe(1)
  })
})

describe("Cloudflare FileObjects adapter", () => {
  test("owns locators, maps head metadata, and issues verifiable URLs", async () => {
    const bucket = makeBucket({
      head: async () => ({
        size: 12,
        etag: "r2-etag",
        httpMetadata: { contentType: "text/plain" },
      }),
    })
    const objects = makeCloudflareFileObjects({
      bucket,
      capabilityOrigin: new URL("https://files.example.com"),
      signingSecret,
      capabilityPolicy,
    })
    const fileSystemId = FileSystemIdSchema.make("workspace-1")
    const fileId = FileIdSchema.make("file-1")
    const objectLocator = objects.locationFor(fileSystemId, fileId)
    const expiresAt = TimestampMillisSchema.make(
      Date.now() + objects.uploadCapabilityTtlMillis,
    )

    const metadata = await Effect.runPromise(objects.stat(objectLocator))
    const capability = await Effect.runPromise(
      objects.issueUpload({
        locator: objectLocator,
        maximumBytes: ByteCountSchema.make(12),
        expiresAt,
      }),
    )
    const token = new URL(capability.url).pathname.slice("/o/".length)
    const verified = await Effect.runPromise(
      verifyFileCapability({
        token,
        signingSecret,
        expectedOperation: "put",
        now: capability.expiresAt - 1,
      }),
    )

    expect(objectLocator).toMatch(/^files\/v1\/[0-9a-f-]{36}$/u)
    expect(objectLocator).not.toContain(fileSystemId)
    expect(metadata).toEqual({
      size: 12,
      contentType: "text/plain",
      digest: { _tag: "OpaqueEtag", value: "r2-etag" },
    })
    expect(verified.operation).toBe("put")
    expect(verified.locator).toBe(objectLocator)
    expect(capability.expiresAt).toBe(expiresAt)
    expect(objects.uploadCapabilityTtlMillis).toBe(
      capabilityPolicy.uploadCapabilityTtlMillis,
    )
    expect(objects.reclamationGraceMillis).toBe(
      capabilityPolicy.reclamationGraceMillis,
    )
  })

  test("rejects weak signing secrets at construction", () => {
    expect(() =>
      makeCloudflareFileObjects({
        bucket: makeBucket(),
        capabilityOrigin: new URL("https://files.example.com"),
        signingSecret: Redacted.make("weak"),
        capabilityPolicy,
      }),
    ).toThrow(/at least 32 UTF-8 bytes/u)
    expect(() =>
      makeCloudflareFileDataPlaneHandler({
        bucket: makeBucket(),
        signingSecret: Redacted.make("weak"),
        capabilityPolicy,
      }),
    ).toThrow(/at least 32 UTF-8 bytes/u)
  })

  test("deletes an object idempotently through the R2 seam", async () => {
    const stored = new Set<string>([locator])
    const bucket = makeBucket({
      delete: async (key) => {
        stored.delete(key)
      },
    })
    const objects = makeCloudflareFileObjects({
      bucket,
      capabilityOrigin: new URL("https://files.example.com"),
      signingSecret,
      capabilityPolicy,
    })

    await Effect.runPromise(objects.delete(locator))
    await Effect.runPromise(objects.delete(locator))

    expect(stored.has(locator)).toBe(false)
  })
})
