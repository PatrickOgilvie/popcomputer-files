import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Redacted, Schema } from "effect"
import { makeFilesClient, type FilesFetch } from "../src/client.js"
import { FileNotFound, FilesUnauthorized } from "../src/errors.js"
import {
  ByteCountSchema,
  FileActorIdSchema,
  FileActorKindSchema,
  FileActorSchema,
  FileContentTypeSchema,
  FileIdSchema,
  FileNameSchema,
  FileSystemIdSchema,
  IdempotencyKeySchema,
  PageSizeSchema,
  Sha256Schema,
  TimestampMillisSchema,
  rootListTarget,
} from "../src/file.js"
import {
  FileSystem,
  fixedQuotaPolicyLayer,
  layer as fileSystemLayer,
} from "../src/file-system.js"
import {
  FileErrorDtoSchema,
  makeFilesHttpHandler,
  type FilesHttpAuthorizer,
} from "../src/http.js"
import { layer as inMemoryLayer } from "../src/in-memory.js"
import { FileTestControl } from "../src/testing.js"

const actor = FileActorSchema.make({
  kind: FileActorKindSchema.make("test"),
  id: FileActorIdSchema.make("actor-1"),
})

const fileSystemId = FileSystemIdSchema.make("http-tests")

const bytes = (value: number) => ByteCountSchema.make(value)
const name = (value: string) => FileNameSchema.make(value)
const contentType = (value: string) => FileContentTypeSchema.make(value)

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

const authorizer: FilesHttpAuthorizer = {
  authorize: (request) =>
    request.headers.get("authorization") === "Bearer test-token"
      ? Effect.succeed({ fileSystemId, actor })
      : Effect.fail(new FilesUnauthorized()),
}

const runtimeLayer = fileSystemLayer({
  maximumUploadBytes: bytes(100),
}).pipe(
  Layer.provideMerge(
    Layer.merge(
      inMemoryLayer(),
      fixedQuotaPolicyLayer(bytes(1_000)),
    ),
  ),
)

describe("files HTTP handler and client", () => {
  it.effect("rejects unauthenticated, malformed, and oversized command bodies", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const handler = makeFilesHttpHandler({
        fileSystem: files,
        authorizer,
      })

      const unauthenticated = yield* Effect.promise(() =>
        handler(new Request("https://api.invalid/files")),
      )
      expect(unauthenticated.status).toBe(401)

      const invalid = yield* Effect.promise(() =>
        handler(
          new Request("https://api.invalid/files/folders", {
            method: "POST",
            headers: {
              authorization: "Bearer test-token",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              parentId: null,
              name: "documents",
              scope: "caller-controlled",
            }),
          }),
        ),
      )
      expect(invalid.status).toBe(400)
      const input: unknown = yield* Effect.promise(() => invalid.json())
      const envelope = yield* Schema.decodeUnknownEffect(FileErrorDtoSchema)(
        input,
        { onExcessProperty: "error" },
      )
      expect(envelope.error.code).toBe("invalid_body")

      const oversized = yield* Effect.promise(() =>
        handler(
          new Request("https://api.invalid/files/folders", {
            method: "POST",
            headers: {
              authorization: "Bearer test-token",
              "content-length": "20000",
              "content-type": "application/json",
            },
            body: "x".repeat(20_000),
          }),
        ),
      )
      expect(oversized.status).toBe(400)

      const streamedOversized = yield* Effect.promise(() =>
        handler(
          new Request("https://api.invalid/files/folders", {
            method: "POST",
            headers: {
              authorization: "Bearer test-token",
              "content-type": "application/json",
            },
            body: "x".repeat(20_000),
          }),
        ),
      )
      expect(streamedOversized.status).toBe(400)

      const lyingLength = yield* Effect.promise(() =>
        handler(
          new Request("https://api.invalid/files/folders", {
            method: "POST",
            headers: {
              authorization: "Bearer test-token",
              "content-length": "1",
              "content-type": "application/json",
            },
            body: "x".repeat(20_000),
          }),
        ),
      )
      expect(lyingLength.status).toBe(400)

      const invalidUtf8 = yield* Effect.promise(() =>
        handler(
          new Request("https://api.invalid/files/folders", {
            method: "POST",
            headers: {
              authorization: "Bearer test-token",
              "content-type": "application/json",
            },
            body: new Uint8Array([0xff]),
          }),
        ),
      )
      expect(invalidUtf8.status).toBe(400)

      const missingIdempotencyKey = yield* Effect.promise(() =>
        handler(
          new Request("https://api.invalid/files/folders", {
            method: "POST",
            headers: {
              authorization: "Bearer test-token",
              "content-type": "application/json",
            },
            body: JSON.stringify({ parentId: null, name: "documents" }),
          }),
        ),
      )
      expect(missingIdempotencyKey.status).toBe(400)
    }).pipe(Effect.provide(runtimeLayer)),
  )

  it.effect("replays folder creation through the HTTP client", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const controls = yield* FileTestControl
      const observedKeys: Array<string | null> = []
      const handler = makeFilesHttpHandler({ fileSystem: files, authorizer })
      const client = makeFilesClient({
        baseUrl: new URL("https://api.invalid/files"),
        apiToken: Redacted.make("test-token"),
        fetch: (request) => {
          observedKeys.push(request.headers.get("idempotency-key"))
          return handler(request)
        },
      })
      const request = {
        parentId: null,
        name: name("documents"),
        idempotencyKey: IdempotencyKeySchema.make("folder-documents"),
      }

      const created = yield* client.createFolder(request)
      const replay = yield* client.createFolder(request)
      expect(replay).toEqual(created)
      expect(observedKeys).toEqual(["folder-documents", "folder-documents"])
      expect(yield* controls.liveNodes(fileSystemId)).toHaveLength(1)

      const conflict = yield* Effect.flip(
        client.createFolder({ ...request, name: name("other") }),
      )
      expect(conflict.reason).toBe("rejected")
      expect(conflict.code).toBe("idempotency_conflict")
    }).pipe(Effect.provide(runtimeLayer)),
  )

  it("cancels a stalled command body promptly when its request is aborted", async () => {
    const files = await Effect.runPromise(
      FileSystem.pipe(Effect.provide(runtimeLayer)),
    )
    let createCalled = false
    const handler = makeFilesHttpHandler({
      fileSystem: {
        ...files,
        createFolder: (input) => {
          createCalled = true
          return files.createFolder(input)
        },
      },
      authorizer,
    })
    let resolveBodyRead: () => void = () => undefined
    const bodyRead = new Promise<void>((resolve) => {
      resolveBodyRead = resolve
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
          controller.enqueue(new TextEncoder().encode("{"))
          return
        }
        resolveBodyRead()
      },
      cancel: () => {
        resolveBodyCancelled()
      },
    })
    const abort = new AbortController()
    const requestInit: RequestInit & { readonly duplex: "half" } = {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-length": "2",
        "content-type": "application/json",
        "idempotency-key": "cancelled-folder",
      },
      body,
      duplex: "half",
      signal: abort.signal,
    }
    const responsePromise = handler(
      new Request("https://api.invalid/files/folders", requestInit),
    )

    await promptly(bodyRead, "command-body read")
    abort.abort(new DOMException("Request cancelled.", "AbortError"))

    const response = await promptly(responsePromise, "aborted HTTP handler")
    expect(response.status).toBe(499)
    await promptly(bodyCancelled, "aborted command body")
    expect(createCalled).toBe(false)
  })

  it("requires HTTPS unless development HTTP is explicitly enabled", () => {
    expect(() =>
      makeFilesClient({
        baseUrl: new URL("http://localhost:8787/files"),
        apiToken: Redacted.make("test-token"),
      }),
    ).toThrow("must use HTTPS")

    expect(
      makeFilesClient({
        baseUrl: new URL("http://localhost:8787/files"),
        apiToken: Redacted.make("test-token"),
        allowInsecureHttp: true,
      }),
    ).toBeDefined()
  })

  it.effect("moves, renames and conditionally deletes through the client", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const handler = makeFilesHttpHandler({ fileSystem: files, authorizer })
      const client = makeFilesClient({
        baseUrl: new URL("https://api.invalid/files"),
        apiToken: Redacted.make("test-token"),
        fetch: handler,
      })
      const folder = (folderName: string) =>
        client.createFolder({
          parentId: null,
          name: name(folderName),
          idempotencyKey: IdempotencyKeySchema.make(`folder-${folderName}`),
        })
      const inbox = yield* folder("inbox")
      const archive = yield* folder("archive")

      const renamed = yield* client.moveNode({
        fileId: inbox.id,
        name: name("incoming"),
      })
      expect(renamed.path).toBe("incoming")
      expect(renamed.parentId).toBeNull()

      const moved = yield* client.moveNode({
        fileId: inbox.id,
        parentId: archive.id,
        name: name("incoming"),
        expectedUpdatedAt: renamed.updatedAt,
      })
      expect(moved.path).toBe("archive/incoming")

      const stale = yield* Effect.flip(
        client.moveNode({
          fileId: inbox.id,
          parentId: null,
          name: name("inbox"),
          expectedUpdatedAt: renamed.updatedAt,
        }),
      )
      expect(stale.code).toBe("stale_file")

      const intoItself = yield* Effect.flip(
        client.moveNode({
          fileId: archive.id,
          parentId: inbox.id,
          name: name("archive"),
        }),
      )
      expect(intoItself.code).toBe("move_into_itself")

      const staleDelete = yield* Effect.flip(
        client.softDelete(archive.id, {
          expectedUpdatedAt: TimestampMillisSchema.make(archive.updatedAt + 1),
        }),
      )
      expect(staleDelete.code).toBe("stale_file")
      yield* client.softDelete(archive.id, {
        expectedUpdatedAt: archive.updatedAt,
      })
      const page = yield* client.listChildren({
        target: rootListTarget,
        page: { size: PageSizeSchema.make(50), cursor: null },
      })
      expect(page.items).toEqual([])
    }).pipe(Effect.provide(runtimeLayer)),
  )

  it.effect("signs a declared digest and media type into the upload capability", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const controls = yield* FileTestControl
      const handler = makeFilesHttpHandler({ fileSystem: files, authorizer })
      const client = makeFilesClient({
        baseUrl: new URL("https://api.invalid/files"),
        apiToken: Redacted.make("test-token"),
        fetch: handler,
      })
      const sha256 = Sha256Schema.make("a".repeat(64))
      yield* client.requestUpload({
        parentId: null,
        name: name("digest.txt"),
        size: bytes(3),
        idempotencyKey: IdempotencyKeySchema.make("digest-upload"),
        sha256,
      })
      const issued = yield* controls.issuedCapabilities()
      const upload = issued[issued.length - 1]
      expect(upload?._tag === "Upload" ? upload.sha256 : null).toBe(sha256)

      const invalid = yield* Effect.promise(() =>
        handler(
          new Request("https://api.invalid/files/upload-url", {
            method: "POST",
            headers: {
              authorization: "Bearer test-token",
              "content-type": "application/json",
              "idempotency-key": "invalid-digest",
            },
            body: JSON.stringify({
              parentId: null,
              name: "bad.txt",
              size: 1,
              sha256: "not-a-digest",
            }),
          }),
        ),
      )
      expect(invalid.status).toBe(400)
    }).pipe(Effect.provide(runtimeLayer)),
  )

  it.effect("runs reserve, capability PUT, confirm, and list without leaking API auth", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const controls = yield* FileTestControl
      const handler = makeFilesHttpHandler({
        fileSystem: files,
        authorizer,
      })
      const capabilityAuthorization: Array<string | null> = []

      const fetchRequest: FilesFetch = async (request) => {
        const url = new URL(request.url)
        if (url.origin !== "https://in-memory.invalid") {
          return handler(request)
        }

        capabilityAuthorization.push(request.headers.get("authorization"))
        if (request.method !== "PUT") {
          return new Response(null, { status: 405 })
        }
        const body = new Uint8Array(await request.arrayBuffer())
        const nodes = await Effect.runPromise(
          controls.liveNodes(fileSystemId),
        )
        const pending = nodes.find((node) => node._tag === "PendingFile")
        if (pending === undefined) {
          return new Response(null, { status: 404 })
        }
        const requestContentType = request.headers.get("content-type")
        await Effect.runPromise(
          controls.putObject({
            fileSystemId,
            fileId: pending.id,
            size: bytes(body.byteLength),
            contentType:
              requestContentType === null
                ? null
                : contentType(requestContentType),
            digest: null,
          }),
        )
        return new Response(null, { status: 204 })
      }

      const client = makeFilesClient({
        baseUrl: new URL("https://api.invalid/files"),
        apiToken: Redacted.make("test-token"),
        fetch: fetchRequest,
      })
      const ready = yield* client.putFile({
        parentId: null,
        name: name("report.txt"),
        size: bytes(3),
        idempotencyKey: IdempotencyKeySchema.make("report-upload"),
        contentType: contentType("text/plain"),
        openBody: () => new Blob([new Uint8Array([1, 2, 3])]).stream(),
      })
      expect(ready._tag).toBe("ReadyFile")
      expect(ready.size).toBe(3)
      expect(capabilityAuthorization).toEqual([null])

      const page = yield* client.listChildren({
        target: rootListTarget,
        page: {
          size: PageSizeSchema.make(50),
          cursor: null,
        },
      })
      expect(page.items.map((node) => node.name)).toEqual(["report.txt"])
    }).pipe(Effect.provide(runtimeLayer)),
  )

  it("aborts the capability PUT when putFile is interrupted", async () => {
    const files = await Effect.runPromise(
      FileSystem.pipe(Effect.provide(runtimeLayer)),
    )
    let confirmCalled = false
    const handler = makeFilesHttpHandler({
      fileSystem: {
        ...files,
        confirmUpload: (input) => {
          confirmCalled = true
          return files.confirmUpload(input)
        },
      },
      authorizer,
    })
    let resolveCapabilityStarted: () => void = () => undefined
    const capabilityStarted = new Promise<void>((resolve) => {
      resolveCapabilityStarted = resolve
    })
    let resolveCapabilityAborted: () => void = () => undefined
    const capabilityAborted = new Promise<void>((resolve) => {
      resolveCapabilityAborted = resolve
    })
    let rejectCapability: (cause: unknown) => void = () => undefined
    const pendingCapability = new Promise<Response>((_resolve, reject) => {
      rejectCapability = reject
    })
    const observedCapability: { signal: AbortSignal | null } = { signal: null }
    const fetchRequest: FilesFetch = (request) => {
      if (new URL(request.url).origin === "https://api.invalid") {
        return handler(request)
      }
      observedCapability.signal = request.signal
      if (request.signal.aborted) {
        resolveCapabilityAborted()
      } else {
        request.signal.addEventListener("abort", resolveCapabilityAborted, {
          once: true,
        })
      }
      resolveCapabilityStarted()
      return pendingCapability
    }
    const client = makeFilesClient({
      baseUrl: new URL("https://api.invalid/files"),
      apiToken: Redacted.make("test-token"),
      fetch: fetchRequest,
    })
    const fiber = Effect.runFork(
      client.putFile({
        parentId: null,
        name: name("cancelled-upload.txt"),
        size: bytes(1),
        idempotencyKey: IdempotencyKeySchema.make("cancelled-client-upload"),
        contentType: contentType("text/plain"),
        openBody: () => new Blob([new Uint8Array([1])]).stream(),
      }),
    )

    await promptly(capabilityStarted, "capability PUT start")
    await promptly(
      Effect.runPromise(Fiber.interrupt(fiber)),
      "putFile interruption",
    )

    await promptly(capabilityAborted, "capability request abort")
    expect(observedCapability.signal?.aborted).toBe(true)
    expect(confirmCalled).toBe(false)

    rejectCapability(new Error("late capability failure"))
    await Promise.resolve()
  })

  it.effect("rejects malformed successful responses instead of trusting JSON", () =>
    Effect.gen(function* () {
      const client = makeFilesClient({
        baseUrl: new URL("https://api.invalid/files"),
        apiToken: Redacted.make("test-token"),
        fetch: async () =>
          new Response(JSON.stringify({ items: [], cursor: null, extra: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      })

      const error = yield* Effect.flip(
        client.listChildren({
          target: rootListTarget,
          page: {
            size: PageSizeSchema.make(50),
            cursor: null,
          },
        }),
      )
      expect(error.reason).toBe("invalid_response")
    }),
  )

  it.effect("preserves a validated server rejection code", () =>
    Effect.gen(function* () {
      const client = makeFilesClient({
        baseUrl: new URL("https://api.invalid/files"),
        apiToken: Redacted.make("test-token"),
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "name_conflict",
                message: "That name is already in use.",
              },
            }),
            {
              status: 409,
              headers: { "content-type": "application/json" },
            },
          ),
      })

      const error = yield* Effect.flip(
        client.createFolder({
          parentId: null,
          name: name("documents"),
          idempotencyKey: IdempotencyKeySchema.make("folder-documents"),
        }),
      )
      expect(error.reason).toBe("rejected")
      expect(error.code).toBe("name_conflict")
    }),
  )

  it.effect("decodes percent-encoded file IDs in item routes", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      let observedFileId: string | null = null
      const handler = makeFilesHttpHandler({
        fileSystem: {
          ...files,
          confirmUpload: (input) => {
            observedFileId = input.fileId
            return Effect.fail(new FileNotFound({ fileId: input.fileId }))
          },
        },
        authorizer,
      })

      const response = yield* Effect.promise(() =>
        handler(
          new Request("https://api.invalid/files/tenant%3Afile/confirm", {
            method: "POST",
            headers: { authorization: "Bearer test-token" },
          }),
        ),
      )

      expect(response.status).toBe(404)
      expect(observedFileId).toBe(FileIdSchema.make("tenant:file"))

      const malformed = yield* Effect.promise(() =>
        handler(
          new Request("https://api.invalid/files/file%ZZ/confirm", {
            method: "POST",
            headers: { authorization: "Bearer test-token" },
          }),
        ),
      )
      expect(malformed.status).toBe(400)
    }).pipe(Effect.provide(runtimeLayer)),
  )

  it.effect("snapshots the base URL and caps streamed response bodies", () =>
    Effect.gen(function* () {
      const baseUrl = new URL("https://api.invalid/files/")
      const requestedOrigins: Array<string> = []
      let cancelled = false
      const client = makeFilesClient({
        baseUrl,
        apiToken: Redacted.make("test-token"),
        maximumResponseBodyBytes: 32,
        fetch: async (request) => {
          requestedOrigins.push(new URL(request.url).origin)
          return new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                controller.enqueue(new Uint8Array(33))
              },
              cancel: () => {
                cancelled = true
              },
            }),
            { status: 200 },
          )
        },
      })
      baseUrl.hostname = "attacker.invalid"

      const error = yield* Effect.flip(
        client.listChildren({
          target: rootListTarget,
          page: {
            size: PageSizeSchema.make(50),
            cursor: null,
          },
        }),
      )

      expect(error.reason).toBe("invalid_response")
      expect(requestedOrigins).toEqual(["https://api.invalid"])
      expect(cancelled).toBe(true)
    }),
  )

  it.effect("rejects invalid UTF-8 in control-plane responses", () =>
    Effect.gen(function* () {
      const client = makeFilesClient({
        baseUrl: new URL("https://api.invalid/files"),
        apiToken: Redacted.make("test-token"),
        fetch: async () =>
          new Response(new Uint8Array([0xff]), { status: 200 }),
      })

      const error = yield* Effect.flip(
        client.listChildren({
          target: rootListTarget,
          page: {
            size: PageSizeSchema.make(50),
            cursor: null,
          },
        }),
      )

      expect(error.reason).toBe("invalid_response")
    }),
  )
})
