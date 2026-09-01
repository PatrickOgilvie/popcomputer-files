import { Effect, Result, Schema } from "effect"
import {
  FileCapabilityUnavailable,
  FileCatalogUnavailable,
  FolderNoLongerAvailable,
  FileNameConflict,
  FileNotFound,
  FileObjectStoreUnavailable,
  FileQuotaExceeded,
  FileQuotaPolicyUnavailable,
  FileRequired,
  FilesForbidden,
  FilesUnauthorized,
  FileTooLarge,
  FolderRequired,
  IdempotencyConflict,
  InvalidFileInput,
  InvalidStoredFile,
  UploadAlreadyConfirmed,
  UploadNoLongerAvailable,
  UploadNotFound,
} from "./errors.js"
import {
  FileIdSchema,
  FileListTargetSchema,
  PageCursorSchema,
  PageSizeSchema,
  parseFileName,
  parseRelativePath,
  rootListTarget,
  type FileActor,
  type FileListTarget,
  type FileSystemId,
  type PageCursor,
  type PageSize,
} from "./file.js"
import type { FileSystemService } from "./file-system.js"
import {
  CreateFolderBodySchema,
  DownloadTicketDtoSchema,
  FileErrorDtoSchema,
  FileNodeDtoSchema,
  FileNodeResponseDtoSchema,
  FilePageDtoSchema,
  FolderIdempotencyKeySchema,
  RenameFileBodySchema,
  RequestUploadBodySchema,
  UploadIdempotencyKeySchema,
  UploadTicketDtoSchema,
  downloadTicketFromDto,
  downloadTicketToDto,
  fileNodeFromDto,
  fileNodeToDto,
  filePageFromDto,
  filePageToDto,
  uploadTicketFromDto,
  uploadTicketToDto,
  type DownloadTicketDto,
  type FileErrorDto,
  type FileNodeDto,
  type FileNodeResponseDto,
  type FilePageDto,
  type UploadTicketDto,
} from "./protocol.js"

/** Permission requested from the host application's authorizer. */
export type FilesPermission = "read" | "write" | "delete"

/** Authenticated filesystem identity and actor derived by the host application. */
export interface AuthorizedFilesRequest {
  readonly fileSystemId: FileSystemId
  readonly actor: FileActor
}

/** Host-owned authentication and permission seam for the control plane. */
export interface FilesHttpAuthorizer {
  readonly authorize: (
    request: Request,
    permission: FilesPermission,
  ) => Effect.Effect<
    AuthorizedFilesRequest,
    FilesUnauthorized | FilesForbidden
  >
}

/** Options for the standard Fetch control-plane handler. */
export interface FilesHttpHandlerOptions {
  readonly fileSystem: FileSystemService
  readonly authorizer: FilesHttpAuthorizer
  /** Mount path without a trailing slash. Defaults to `/files`. */
  readonly basePath?: string
  /** Maximum JSON command body size. Defaults to 16 KiB. */
  readonly maximumCommandBodyBytes?: number
}

type FilesHttpError =
  | FilesUnauthorized
  | FilesForbidden
  | InvalidFileInput
  | FileNotFound
  | FolderRequired
  | FileRequired
  | FileNameConflict
  | IdempotencyConflict
  | FolderNoLongerAvailable
  | UploadAlreadyConfirmed
  | UploadNoLongerAvailable
  | UploadNotFound
  | FileTooLarge
  | FileQuotaExceeded
  | InvalidStoredFile
  | FileCatalogUnavailable
  | FileObjectStoreUnavailable
  | FileCapabilityUnavailable
  | FileQuotaPolicyUnavailable

type FilesHttpResponseBody =
  | DownloadTicketDto
  | FileErrorDto
  | FileNodeResponseDto
  | FilePageDto
  | UploadTicketDto

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const

const defaultMaximumCommandBodyBytes = 16 * 1024

const jsonResponse = (value: FilesHttpResponseBody, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: jsonHeaders })

const invalidInput = (reason: InvalidFileInput["reason"]) =>
  new InvalidFileInput({ reason })

const decodeString = <A>(
  schema: Schema.Decoder<A>,
  input: string,
  reason: InvalidFileInput["reason"],
): Effect.Effect<A, InvalidFileInput> =>
  Schema.decodeUnknownEffect(schema)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => invalidInput(reason)))

const readJson = <A>(
  request: Request,
  schema: Schema.Decoder<A>,
  maximumBodyBytes: number,
): Effect.Effect<A, InvalidFileInput> =>
  Effect.tryPromise({
    try: async (signal) => {
      const declaredLength = request.headers.get("content-length")
      if (
        declaredLength !== null &&
        (!/^(0|[1-9][0-9]*)$/u.test(declaredLength) ||
          Number(declaredLength) > maximumBodyBytes)
      ) {
        throw new Error("The file command body is too large.")
      }
      if (request.body === null) return ""

      const reader = request.body.getReader()
      let cancellation: Promise<void> | null = null
      const cancelReader = () => {
        if (cancellation !== null) return
        cancellation = reader.cancel(signal.reason).then(
          () => undefined,
          () => undefined,
        )
      }
      let abortListenerAttached = false
      if (signal.aborted) {
        cancelReader()
      } else {
        signal.addEventListener("abort", cancelReader, { once: true })
        abortListenerAttached = true
      }
      const decoder = new TextDecoder("utf-8", { fatal: true })
      let total = 0
      let text = ""
      try {
        signal.throwIfAborted()
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          total += next.value.byteLength
          if (total > maximumBodyBytes) {
            await reader.cancel()
            throw new Error("The file command body is too large.")
          }
          text += decoder.decode(next.value, { stream: true })
        }
        return text + decoder.decode()
      } finally {
        if (abortListenerAttached) {
          signal.removeEventListener("abort", cancelReader)
        }
        if (signal.aborted) {
          cancelReader()
        }
        if (cancellation !== null) {
          await cancellation
        }
        reader.releaseLock()
      }
    },
    catch: () => invalidInput("invalid_body"),
  }).pipe(
    Effect.flatMap((text) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => invalidInput("invalid_body"))),
    ),
  )

const parseFileId = (input: string) =>
  decodeString(FileIdSchema, input, "invalid_file_id")

const parseRouteFileId = (
  input: string,
): Effect.Effect<Schema.Schema.Type<typeof FileIdSchema>, InvalidFileInput> =>
  Effect.try({
    try: () => decodeURIComponent(input),
    catch: () => invalidInput("invalid_file_id"),
  }).pipe(Effect.flatMap(parseFileId))

const parseListTarget = (
  url: URL,
): Effect.Effect<FileListTarget, InvalidFileInput> =>
  Effect.gen(function* () {
    const rawParentId = url.searchParams.get("parentId")
    const rawPath = url.searchParams.get("path")
    if (
      rawParentId !== null &&
      rawParentId.length > 0 &&
      rawPath !== null &&
      rawPath.length > 0
    ) {
      return yield* Effect.fail(invalidInput("invalid_path"))
    }
    if (rawParentId !== null && rawParentId.length > 0) {
      const id = yield* parseFileId(rawParentId)
      return FileListTargetSchema.cases.FolderId.make({ id })
    }
    if (rawPath !== null && rawPath.length > 0) {
      const path = yield* parseRelativePath(rawPath).pipe(
        Effect.mapError(() => invalidInput("invalid_path")),
      )
      return FileListTargetSchema.cases.Path.make({ path })
    }
    return rootListTarget
  })

const parsePage = (
  url: URL,
): Effect.Effect<
  { readonly size: PageSize; readonly cursor: PageCursor | null },
  InvalidFileInput
> =>
  Effect.gen(function* () {
    const rawLimit = url.searchParams.get("limit")
    let size: PageSize
    if (rawLimit === null || rawLimit.length === 0) {
      size = PageSizeSchema.make(50)
    } else {
      const numeric = Number(rawLimit)
      if (!Number.isSafeInteger(numeric) || numeric < 1) {
        return yield* Effect.fail(invalidInput("invalid_body"))
      }
      size = PageSizeSchema.make(Math.min(numeric, 100))
    }

    const rawCursor = url.searchParams.get("cursor")
    if (rawCursor === null || rawCursor.length === 0) {
      return { size, cursor: null }
    }
    const cursor = yield* decodeString(
      PageCursorSchema,
      rawCursor,
      "invalid_cursor",
    )
    return { size, cursor }
  })

const toErrorResponse = (error: FilesHttpError): Response => {
  switch (error._tag) {
    case "FilesUnauthorized":
      return jsonResponse(
        { error: { code: "unauthorized", message: "Authentication required." } },
        401,
      )
    case "FilesForbidden":
      return jsonResponse(
        { error: { code: "forbidden", message: "Permission denied." } },
        403,
      )
    case "InvalidFileInput":
      return jsonResponse(
        { error: { code: error.reason, message: "File input is invalid." } },
        400,
      )
    case "FileNotFound":
      return jsonResponse(
        { error: { code: "file_not_found", message: "File was not found." } },
        404,
      )
    case "FolderRequired":
      return jsonResponse(
        { error: { code: "folder_required", message: "A folder is required." } },
        400,
      )
    case "FileRequired":
      return jsonResponse(
        { error: { code: "not_a_file", message: "A file is required." } },
        400,
      )
    case "FileNameConflict":
      return jsonResponse(
        { error: { code: "name_conflict", message: "That name is already in use." } },
        409,
      )
    case "IdempotencyConflict":
      return jsonResponse(
        { error: { code: "idempotency_conflict", message: "The idempotency key was used for another command." } },
        409,
      )
    case "FolderNoLongerAvailable":
      return jsonResponse(
        { error: { code: "folder_unavailable", message: "The folder is no longer available." } },
        409,
      )
    case "UploadAlreadyConfirmed":
      return jsonResponse(
        { error: { code: "upload_already_confirmed", message: "The upload is already confirmed." } },
        409,
      )
    case "UploadNoLongerAvailable":
      return jsonResponse(
        { error: { code: "upload_unavailable", message: "The upload is no longer available." } },
        409,
      )
    case "UploadNotFound":
      return jsonResponse(
        { error: { code: "upload_not_found", message: "Uploaded bytes were not found." } },
        409,
      )
    case "FileTooLarge":
      return jsonResponse(
        { error: { code: "file_too_large", message: "The file is too large." } },
        413,
      )
    case "FileQuotaExceeded":
      return jsonResponse(
        { error: { code: "quota_exceeded", message: "The storage quota is exceeded." } },
        413,
      )
    case "InvalidStoredFile":
      return jsonResponse(
        { error: { code: "invalid_file_node", message: "Stored file metadata is invalid." } },
        500,
      )
    case "FileCatalogUnavailable":
    case "FileObjectStoreUnavailable":
    case "FileCapabilityUnavailable":
    case "FileQuotaPolicyUnavailable":
      return jsonResponse(
        { error: { code: "file_store_unavailable", message: "The file store is unavailable." } },
        503,
      )
  }
}

const runResponse = async (
  request: Request,
  effect: Effect.Effect<Response, FilesHttpError>,
): Promise<Response> => {
  try {
    const result = await Effect.runPromise(Effect.result(effect), {
      signal: request.signal,
    })
    return Result.isSuccess(result)
      ? result.success
      : toErrorResponse(result.failure)
  } catch {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 })
    }
    return jsonResponse(
      { error: { code: "internal_error", message: "An internal error occurred." } },
      500,
    )
  }
}

const splitRoute = (pathname: string, basePath: string): ReadonlyArray<string> | null => {
  if (pathname === basePath || pathname === `${basePath}/`) return []
  if (!pathname.startsWith(`${basePath}/`)) return null
  return pathname.slice(basePath.length + 1).split("/")
}

/**
 * Build the canonical machine control-plane handler.
 *
 * Scope and actor are always derived by `authorizer`; request bodies and query
 * strings never carry them.
 */
export const makeFilesHttpHandler = (
  options: FilesHttpHandlerOptions,
): ((request: Request) => Promise<Response>) => {
  const basePath = options.basePath ?? "/files"
  const maximumBodyBytes =
    options.maximumCommandBodyBytes ?? defaultMaximumCommandBodyBytes
  if (!Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes <= 0) {
    throw new Error("The maximum file command body size is invalid.")
  }

  return async (request) => {
    const url = new URL(request.url)
    const route = splitRoute(url.pathname, basePath)
    if (route === null) return new Response(null, { status: 404 })

    const program = Effect.gen(function* () {
      if (route.length === 0 && request.method === "GET") {
        const authorized = yield* options.authorizer.authorize(request, "read")
        const target = yield* parseListTarget(url)
        const page = yield* parsePage(url)
        const result = yield* options.fileSystem.listChildren({
          ...authorized,
          target,
          page,
        })
        return jsonResponse(filePageToDto(result))
      }

      if (
        route.length === 1 &&
        route[0] === "folders" &&
        request.method === "POST"
      ) {
        const authorized = yield* options.authorizer.authorize(request, "write")
        const body = yield* readJson(
          request,
          CreateFolderBodySchema,
          maximumBodyBytes,
        )
        const name = yield* parseFileName(body.name).pipe(
          Effect.mapError(() => invalidInput("invalid_file_name")),
        )
        const rawIdempotencyKey = request.headers.get("idempotency-key")
        if (rawIdempotencyKey === null) {
          return yield* Effect.fail(invalidInput("invalid_body"))
        }
        const idempotencyKey = yield* decodeString(
          FolderIdempotencyKeySchema,
          rawIdempotencyKey,
          "invalid_body",
        )
        const node = yield* options.fileSystem.createFolder({
          ...authorized,
          parentId: body.parentId,
          name,
          idempotencyKey,
        })
        return jsonResponse({ node: fileNodeToDto(node) }, 201)
      }

      if (
        route.length === 1 &&
        route[0] === "upload-url" &&
        request.method === "POST"
      ) {
        const authorized = yield* options.authorizer.authorize(request, "write")
        const body = yield* readJson(
          request,
          RequestUploadBodySchema,
          maximumBodyBytes,
        )
        const name = yield* parseFileName(body.name).pipe(
          Effect.mapError(() => invalidInput("invalid_file_name")),
        )
        const rawIdempotencyKey = request.headers.get("idempotency-key")
        if (rawIdempotencyKey === null) {
          return yield* Effect.fail(invalidInput("invalid_body"))
        }
        const idempotencyKey = yield* decodeString(
          UploadIdempotencyKeySchema,
          rawIdempotencyKey,
          "invalid_body",
        )
        const ticket = yield* options.fileSystem.requestUpload({
          ...authorized,
          parentId: body.parentId,
          name,
          size: body.size,
          idempotencyKey,
        })
        return jsonResponse(uploadTicketToDto(ticket), 201)
      }

      if (route.length === 2 && route[1] === "confirm" && request.method === "POST") {
        const authorized = yield* options.authorizer.authorize(request, "write")
        const fileId = yield* parseRouteFileId(route[0] ?? "")
        const node = yield* options.fileSystem.confirmUpload({
          ...authorized,
          fileId,
        })
        return jsonResponse({ node: fileNodeToDto(node) })
      }

      if (route.length === 2 && route[1] === "download" && request.method === "GET") {
        const authorized = yield* options.authorizer.authorize(request, "read")
        const fileId = yield* parseRouteFileId(route[0] ?? "")
        const ticket = yield* options.fileSystem.requestDownload({
          ...authorized,
          fileId,
        })
        return jsonResponse(downloadTicketToDto(ticket))
      }

      if (route.length === 1 && request.method === "PATCH") {
        const authorized = yield* options.authorizer.authorize(request, "write")
        const fileId = yield* parseRouteFileId(route[0] ?? "")
        const body = yield* readJson(
          request,
          RenameFileBodySchema,
          maximumBodyBytes,
        )
        const name = yield* parseFileName(body.name).pipe(
          Effect.mapError(() => invalidInput("invalid_file_name")),
        )
        const node = yield* options.fileSystem.renameFile({
          ...authorized,
          fileId,
          name,
        })
        return jsonResponse({ node: fileNodeToDto(node) })
      }

      if (route.length === 1 && request.method === "DELETE") {
        const authorized = yield* options.authorizer.authorize(request, "delete")
        const fileId = yield* parseRouteFileId(route[0] ?? "")
        yield* options.fileSystem.softDelete({ ...authorized, fileId })
        return new Response(null, { status: 204 })
      }

      return new Response(null, {
        status: route.length === 0 || route.length <= 2 ? 405 : 404,
        headers: { allow: "GET, POST, PATCH, DELETE" },
      })
    })

    return runResponse(request, program)
  }
}

export {
  DownloadTicketDtoSchema,
  FileErrorDtoSchema,
  FileNodeDtoSchema,
  FileNodeResponseDtoSchema,
  FilePageDtoSchema,
  UploadTicketDtoSchema,
  downloadTicketFromDto,
  fileNodeFromDto,
  filePageFromDto,
  uploadTicketFromDto,
}

export type {
  DownloadTicketDto,
  FileErrorDto,
  FileNodeDto,
  FileNodeResponseDto,
  FilePageDto,
  UploadTicketDto,
}
