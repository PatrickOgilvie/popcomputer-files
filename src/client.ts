import { Context, Effect, Layer, Redacted, Schema } from "effect"
import {
  FilesClientError,
  type FilesRejectionCode,
} from "./errors.js"
import type {
  ByteCount,
  DownloadTicket,
  FileContentType,
  FileId,
  FileListTarget,
  FileName,
  FileNode,
  FilePage,
  FolderNode,
  IdempotencyKey,
  PageCursor,
  PageSize,
  ReadyFileNode,
  Sha256,
  TimestampMillis,
  UploadTicket,
} from "./file.js"
import { FileContentTypeSchema } from "./file.js"
import {
  DownloadTicketDtoSchema,
  FileErrorDtoSchema,
  FileNodeResponseDtoSchema,
  FilePageDtoSchema,
  UploadTicketDtoSchema,
  downloadTicketFromDto,
  fileNodeFromDto,
  filePageFromDto,
  uploadTicketFromDto,
} from "./protocol.js"

/** Injectable Fetch seam used by every control-plane and capability request. */
export type FilesFetch = (request: Request) => Promise<Response>

/** Concrete client construction options. */
export interface FilesClientOptions {
  /** Absolute URL of the files collection, for example `https://host/api/files`. */
  readonly baseUrl: URL
  /** Machine API bearer token; it is never sent to capability URLs. */
  readonly apiToken: Redacted.Redacted<string>
  /** Optional Fetch-compatible test/runtime adapter. Defaults to global Fetch. */
  readonly fetch?: FilesFetch
  /** Explicit development escape hatch for non-TLS control and capability URLs. */
  readonly allowInsecureHttp?: boolean
  /** Maximum buffered control-plane response size. Defaults to 1 MiB. */
  readonly maximumResponseBodyBytes?: number
}

interface HalfDuplexRequestInit extends RequestInit {
  readonly duplex?: "half"
}

/** List input accepted by the typed client. */
export interface ClientListChildrenInput {
  readonly target: FileListTarget
  readonly page: {
    readonly size: PageSize
    readonly cursor: PageCursor | null
  }
}

/** Folder-create input accepted by the typed client. */
export interface ClientCreateFolderInput {
  readonly parentId: FileId | null
  readonly name: FileName
  readonly idempotencyKey: IdempotencyKey
}

/** Upload-reservation input accepted by the typed client. */
export interface ClientRequestUploadInput {
  readonly parentId: FileId | null
  readonly name: FileName
  readonly size: ByteCount
  readonly idempotencyKey: IdempotencyKey
  /** When set, the store rejects bytes with any other SHA-256. */
  readonly sha256?: Sha256 | null
}

/** Move-or-rename input accepted by the typed client. */
export interface ClientMoveNodeInput {
  readonly fileId: FileId
  readonly name: FileName
  /** Destination folder; omit to rename in place. */
  readonly parentId?: FileId | null
  /** Apply only while the node was last changed at this instant. */
  readonly expectedUpdatedAt?: TimestampMillis
}

interface CreateFolderRequestBody {
  readonly parentId: FileId | null
  readonly name: FileName
}

interface RequestUploadRequestBody extends CreateFolderRequestBody {
  readonly size: ByteCount
  readonly sha256: Sha256 | null
  readonly contentType: FileContentType | null
}

interface MoveNodeRequestBody {
  readonly name: FileName
  readonly parentId?: FileId | null
  readonly expectedUpdatedAt?: string
}

type FilesClientRequestBody =
  | CreateFolderRequestBody
  | MoveNodeRequestBody
  | RequestUploadRequestBody

/** Full direct-upload workflow input with a caller-owned replayable body factory. */
export interface PutFileInput extends ClientRequestUploadInput {
  readonly contentType: FileContentType | null
  readonly openBody: () => BodyInit
}

/** Streamed download response returned without buffering the body. */
export interface DownloadedFile {
  readonly file: ReadyFileNode
  readonly body: ReadableStream<Uint8Array> | null
  readonly contentType: FileContentType | null
}

/** Effect-native hosted files client. */
export interface FilesClientService {
  readonly listChildren: (
    input: ClientListChildrenInput,
  ) => Effect.Effect<FilePage, FilesClientError>
  readonly createFolder: (
    input: ClientCreateFolderInput,
  ) => Effect.Effect<FolderNode, FilesClientError>
  readonly requestUpload: (
    input: ClientRequestUploadInput,
  ) => Effect.Effect<UploadTicket, FilesClientError>
  readonly confirmUpload: (
    fileId: FileId,
  ) => Effect.Effect<ReadyFileNode, FilesClientError>
  readonly requestDownload: (
    fileId: FileId,
  ) => Effect.Effect<DownloadTicket, FilesClientError>
  readonly moveNode: (
    input: ClientMoveNodeInput,
  ) => Effect.Effect<FileNode, FilesClientError>
  readonly softDelete: (
    fileId: FileId,
    condition?: { readonly expectedUpdatedAt?: TimestampMillis },
  ) => Effect.Effect<void, FilesClientError>
  readonly putFile: (
    input: PutFileInput,
  ) => Effect.Effect<ReadyFileNode, FilesClientError>
  readonly download: (
    fileId: FileId,
  ) => Effect.Effect<DownloadedFile, FilesClientError>
}

/** Effect service tag for the hosted files client. */
export class FilesClient extends Context.Service<
  FilesClient,
  FilesClientService
>()("@popcomputer/files/FilesClient") {}

const clientError = (
  operation: string,
  reason: FilesClientError["reason"],
  status: number | null,
  cause: unknown,
  code: FilesRejectionCode | null = null,
) => new FilesClientError({ operation, reason, status, code, cause })

const isAbortCause = (cause: unknown): boolean =>
  cause instanceof DOMException && cause.name === "AbortError"

const defaultMaximumResponseBodyBytes = 1024 * 1024

class InvalidResponseBodyError extends Error {
  readonly _tag = "InvalidResponseBodyError"

  constructor(
    readonly reason: "invalid_encoding" | "invalid_length" | "too_large",
  ) {
    super(`The files response body is invalid: ${reason}.`)
    this.name = "InvalidResponseBodyError"
  }
}

const decodeResponseText = <A>(
  schema: Schema.Decoder<A>,
  text: string,
  operation: string,
  status: number,
): Effect.Effect<A, FilesClientError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(() =>
      clientError(
        operation,
        "invalid_response",
        status,
        "response_schema_mismatch",
      ),
    ),
  )

const responseText = (
  response: Response,
  operation: string,
  maximumBodyBytes: number,
): Effect.Effect<string, FilesClientError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const declaredLength = response.headers.get("content-length")
      if (
        declaredLength !== null &&
        (!/^(0|[1-9][0-9]*)$/u.test(declaredLength) ||
          Number(declaredLength) > maximumBodyBytes)
      ) {
        await response.body?.cancel().catch(() => undefined)
        throw new InvalidResponseBodyError(
          /^(0|[1-9][0-9]*)$/u.test(declaredLength)
            ? "too_large"
            : "invalid_length",
        )
      }
      if (response.body === null) return ""

      const reader = response.body.getReader()
      const decoder = new TextDecoder("utf-8", { fatal: true })
      const cancel = () => {
        void reader.cancel(signal.reason).catch(() => undefined)
      }
      signal.addEventListener("abort", cancel, { once: true })

      let total = 0
      let text = ""
      try {
        for (;;) {
          const next = await reader.read()
          if (signal.aborted) throw signal.reason
          if (next.done) break
          total += next.value.byteLength
          if (total > maximumBodyBytes) {
            await reader.cancel().catch(() => undefined)
            throw new InvalidResponseBodyError("too_large")
          }
          try {
            text += decoder.decode(next.value, { stream: true })
          } catch {
            throw new InvalidResponseBodyError("invalid_encoding")
          }
        }
        try {
          return text + decoder.decode()
        } catch {
          throw new InvalidResponseBodyError("invalid_encoding")
        }
      } finally {
        signal.removeEventListener("abort", cancel)
      }
    },
    catch: (cause) =>
      cause instanceof InvalidResponseBodyError
        ? clientError(
            operation,
            "invalid_response",
            response.status,
            cause.reason,
          )
        : clientError(
            operation,
            isAbortCause(cause) ? "cancelled" : "network",
            response.status,
            cause,
          ),
  })

/** Construct a client directly for use outside an Effect layer graph. */
export const makeFilesClient = (
  options: FilesClientOptions,
): FilesClientService => {
  const baseUrl = new URL(options.baseUrl.href)
  const allowInsecureHttp = options.allowInsecureHttp === true
  const maximumResponseBodyBytes =
    options.maximumResponseBodyBytes ?? defaultMaximumResponseBodyBytes
  if (
    baseUrl.protocol !== "https:" &&
    !(allowInsecureHttp && baseUrl.protocol === "http:")
  ) {
    throw new Error("The files client base URL must use HTTPS.")
  }
  if (
    baseUrl.username.length > 0 ||
    baseUrl.password.length > 0
  ) {
    throw new Error("The files client base URL cannot contain credentials.")
  }
  if (baseUrl.search.length > 0 || baseUrl.hash.length > 0) {
    throw new Error("The files client base URL cannot contain a query or fragment.")
  }
  if (
    !Number.isSafeInteger(maximumResponseBodyBytes) ||
    maximumResponseBodyBytes <= 0
  ) {
    throw new Error("The maximum files response body size is invalid.")
  }
  if (Redacted.value(options.apiToken).length === 0) {
    throw new Error("The files client API token cannot be empty.")
  }
  const executeFetch: FilesFetch =
    options.fetch ?? ((request) => globalThis.fetch(request))
  const collectionUrl = baseUrl.href.endsWith("/")
    ? baseUrl
    : new URL(`${baseUrl.href}/`)

  const endpoint = (path: string): URL => new URL(path, collectionUrl)

  const capabilityUrl = (
    value: string,
    operation: string,
  ): Effect.Effect<URL, FilesClientError> => {
    const url = new URL(value)
    return url.protocol === "https:" ||
      (allowInsecureHttp && url.protocol === "http:")
      ? Effect.succeed(url)
      : Effect.fail(
          clientError(
            operation,
            "invalid_response",
            null,
            "insecure_capability_url",
          ),
        )
  }

  const request = Effect.fn("FilesClient.request")(function* (
    operation: string,
    url: URL,
    init: {
      readonly method: string
      readonly body: BodyInit | null
      readonly headers: Headers
      readonly authenticated: boolean
    },
  ) {
    if (init.authenticated) {
      init.headers.set(
        "authorization",
        `Bearer ${Redacted.value(options.apiToken)}`,
      )
    }
    init.headers.set("accept", "application/json")

    return yield* Effect.tryPromise({
      try: (signal) => {
        const requestInit: HalfDuplexRequestInit =
          init.body instanceof ReadableStream
            ? {
                method: init.method,
                body: init.body,
                headers: init.headers,
                signal,
                duplex: "half",
              }
            : {
                method: init.method,
                body: init.body,
                headers: init.headers,
                signal,
              }
        return executeFetch(new Request(url, requestInit))
      },
      catch: (cause) =>
        clientError(
          operation,
          isAbortCause(cause) ? "cancelled" : "network",
          null,
          cause,
        ),
    })
  })

  const requestJson = <A>(
    operation: string,
    url: URL,
    init: {
      readonly method: string
      readonly body: BodyInit | null
      readonly headers: Headers
      readonly authenticated: boolean
    },
    schema: Schema.Decoder<A>,
  ): Effect.Effect<A, FilesClientError> =>
    request(operation, url, init).pipe(
      Effect.flatMap((response) =>
        responseText(
          response,
          operation,
          maximumResponseBodyBytes,
        ).pipe(
          Effect.flatMap((text) =>
            response.ok
              ? decodeResponseText(schema, text, operation, response.status)
              : decodeResponseText(
                  FileErrorDtoSchema,
                  text,
                  operation,
                  response.status,
                ).pipe(
                  Effect.flatMap((error) =>
                    Effect.fail(
                      clientError(
                        operation,
                        "rejected",
                        response.status,
                        "http_rejected",
                        error.error.code,
                      ),
                    ),
                  ),
                ),
          ),
        ),
      ),
    )

  const authenticatedJson = (
    method: string,
    body: FilesClientRequestBody,
    extraHeaders?: Readonly<Record<string, string>>,
  ) => {
    const headers = new Headers(extraHeaders)
    headers.set("content-type", "application/json")
    return {
      method,
      body: JSON.stringify(body),
      headers,
      authenticated: true,
    } as const
  }

  const authenticatedEmpty = (method: string) => ({
    method,
    body: null,
    headers: new Headers(),
    authenticated: true,
  } as const)

  const listChildren = Effect.fn("FilesClient.listChildren")(function* (
    input: ClientListChildrenInput,
  ) {
    const url = endpoint("")
    url.searchParams.set("limit", String(input.page.size))
    if (input.page.cursor !== null) {
      url.searchParams.set("cursor", input.page.cursor)
    }
    switch (input.target._tag) {
      case "Root":
        break
      case "FolderId":
        url.searchParams.set("parentId", input.target.id)
        break
      case "Path":
        url.searchParams.set("path", input.target.path)
        break
    }
    const dto = yield* requestJson(
      "FilesClient.listChildren",
      url,
      authenticatedEmpty("GET"),
      FilePageDtoSchema,
    )
    return filePageFromDto(dto)
  })

  const createFolder = Effect.fn("FilesClient.createFolder")(function* (
    input: ClientCreateFolderInput,
  ) {
    const dto = yield* requestJson(
      "FilesClient.createFolder",
      endpoint("folders"),
      authenticatedJson(
        "POST",
        {
          parentId: input.parentId,
          name: input.name,
        },
        { "idempotency-key": input.idempotencyKey },
      ),
      FileNodeResponseDtoSchema,
    )
    const node = fileNodeFromDto(dto.node)
    if (node._tag !== "Folder") {
      return yield* Effect.fail(
        clientError(
          "FilesClient.createFolder",
          "invalid_response",
          201,
          "create_folder_response_not_folder",
        ),
      )
    }
    return node
  })

  const requestUpload = Effect.fn("FilesClient.requestUpload")(function* (
    input: ClientRequestUploadInput & {
      readonly contentType?: FileContentType | null
    },
  ) {
    const dto = yield* requestJson(
      "FilesClient.requestUpload",
      endpoint("upload-url"),
      authenticatedJson(
        "POST",
        {
          parentId: input.parentId,
          name: input.name,
          size: input.size,
          sha256: input.sha256 ?? null,
          contentType: input.contentType ?? null,
        },
        { "idempotency-key": input.idempotencyKey },
      ),
      UploadTicketDtoSchema,
    )
    return uploadTicketFromDto(dto)
  })

  const confirmUpload = Effect.fn("FilesClient.confirmUpload")(function* (
    fileId: FileId,
  ) {
    const dto = yield* requestJson(
      "FilesClient.confirmUpload",
      endpoint(`${encodeURIComponent(fileId)}/confirm`),
      authenticatedEmpty("POST"),
      FileNodeResponseDtoSchema,
    )
    const node = fileNodeFromDto(dto.node)
    if (node._tag !== "ReadyFile") {
      return yield* Effect.fail(
        clientError(
          "FilesClient.confirmUpload",
          "invalid_response",
          200,
          "confirm_response_not_ready",
        ),
      )
    }
    return node
  })

  const requestDownload = Effect.fn("FilesClient.requestDownload")(function* (
    fileId: FileId,
  ) {
    const dto = yield* requestJson(
      "FilesClient.requestDownload",
      endpoint(`${encodeURIComponent(fileId)}/download`),
      authenticatedEmpty("GET"),
      DownloadTicketDtoSchema,
    )
    return downloadTicketFromDto(dto)
  })

  const moveNode = Effect.fn("FilesClient.moveNode")(function* (
    input: ClientMoveNodeInput,
  ) {
    const body: MoveNodeRequestBody = {
      name: input.name,
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(input.expectedUpdatedAt === undefined
        ? {}
        : {
            expectedUpdatedAt: new Date(input.expectedUpdatedAt).toISOString(),
          }),
    }
    const dto = yield* requestJson(
      "FilesClient.moveNode",
      endpoint(encodeURIComponent(input.fileId)),
      authenticatedJson("PATCH", body),
      FileNodeResponseDtoSchema,
    )
    return fileNodeFromDto(dto.node)
  })

  const softDelete = Effect.fn("FilesClient.softDelete")(function* (
    fileId: FileId,
    condition?: { readonly expectedUpdatedAt?: TimestampMillis },
  ) {
    const operation = "FilesClient.softDelete"
    const target = endpoint(encodeURIComponent(fileId))
    if (condition?.expectedUpdatedAt !== undefined) {
      target.searchParams.set(
        "expectedUpdatedAt",
        new Date(condition.expectedUpdatedAt).toISOString(),
      )
    }
    const response = yield* request(
      operation,
      target,
      authenticatedEmpty("DELETE"),
    )
    if (response.status === 204) return
    const text = yield* responseText(
      response,
      operation,
      maximumResponseBodyBytes,
    )
    if (!response.ok) {
      const error = yield* decodeResponseText(
        FileErrorDtoSchema,
        text,
        operation,
        response.status,
      )
      return yield* Effect.fail(
        clientError(
          operation,
          "rejected",
          response.status,
          "http_rejected",
          error.error.code,
        ),
      )
    }
    return yield* Effect.fail(
      clientError(
        operation,
        "invalid_response",
        response.status,
        "delete_response_not_empty",
      ),
    )
  })

  const putFile = Effect.fn("FilesClient.putFile")(function* (
    input: PutFileInput,
  ) {
    const ticket = yield* requestUpload(input)
    const body = yield* Effect.try({
      try: input.openBody,
      catch: (cause) =>
        clientError("FilesClient.putFile", "network", null, cause),
    })
    const headers = new Headers()
    if (input.contentType !== null) {
      headers.set("content-type", input.contentType)
    }
    const response = yield* request(
      "FilesClient.putFile.bytes",
      yield* capabilityUrl(ticket.url, "FilesClient.putFile.bytes"),
      {
        method: "PUT",
        body,
        headers,
        authenticated: false,
      },
    )
    if (!response.ok) {
      return yield* Effect.fail(
        clientError(
          "FilesClient.putFile.bytes",
          "rejected",
          response.status,
          "capability_upload_rejected",
        ),
      )
    }
    return yield* confirmUpload(ticket.fileId)
  })

  const download = Effect.fn("FilesClient.download")(function* (
    fileId: FileId,
  ) {
    const ticket = yield* requestDownload(fileId)
    const response = yield* request(
      "FilesClient.download.bytes",
      yield* capabilityUrl(ticket.url, "FilesClient.download.bytes"),
      {
        method: "GET",
        body: null,
        headers: new Headers(),
        authenticated: false,
      },
    )
    if (!response.ok) {
      return yield* Effect.fail(
        clientError(
          "FilesClient.download.bytes",
          "rejected",
          response.status,
          "capability_download_rejected",
        ),
      )
    }
    const rawContentType = response.headers.get("content-type")
    const contentType =
      rawContentType === null
        ? null
        : yield* Schema.decodeUnknownEffect(FileContentTypeSchema)(
            rawContentType,
          ).pipe(
            Effect.mapError(() =>
              clientError(
                "FilesClient.download.bytes",
                "invalid_response",
                response.status,
                "invalid_content_type",
              ),
            ),
          )
    return {
      file: ticket.file,
      body: response.body,
      contentType,
    }
  })

  return FilesClient.of({
    listChildren,
    createFolder,
    requestUpload,
    confirmUpload,
    requestDownload,
    moveNode,
    softDelete,
    putFile,
    download,
  })
}

/** Construct a client layer from concrete options. */
export const layer = (
  options: FilesClientOptions,
): Layer.Layer<FilesClient> =>
  Layer.succeed(FilesClient, makeFilesClient(options))
