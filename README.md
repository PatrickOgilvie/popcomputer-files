# `@popcomputer/files`

Effect-native filesystem primitives for Pop Computer applications on
Cloudflare D1 and R2.

The package is intentionally narrow: one isolated logical filesystem per
workspace or account, a hierarchical D1 catalog, opaque R2 bytes, retry-safe
folder creation and direct uploads, host-side writes and reads, declared
SHA-256 digests, per-filesystem quota, signed downloads, subtree moves and
deletion, a commit-ordered change log, and bounded reclamation. It is not a POSIX API, generic blob
abstraction, or storage-vendor portability layer.

## Install

```sh
bun add @popcomputer/files effect
```

The D1 entry point additionally requires `drizzle-orm`. `effect` and
`drizzle-orm` are peer dependencies so the application owns their runtimes.

## Package map

| Import | Purpose |
|---|---|
| `@popcomputer/files` | Domain schemas, errors, `FileSystem`, and `FileReclaimer` |
| `@popcomputer/files/adapter` | Catalog, byte-object, identity, activity, and reclamation seams |
| `@popcomputer/files/http` | Strict Fetch control-plane handler and wire schemas |
| `@popcomputer/files/client` | Effect HTTP client and upload/download choreography |
| `@popcomputer/files/reclaimer` | Bounded pending-expiry, R2 deletion, and metadata-purge service |
| `@popcomputer/files/d1` | D1 catalog and reclamation adapter |
| `@popcomputer/files/d1/schema` | Package-owned Drizzle schema |
| `@popcomputer/files/cloudflare` | R2 adapter, HMAC capabilities, and byte data plane |
| `@popcomputer/files/in-memory` | Deterministic adapters for behavior tests |
| `@popcomputer/files/testing` | Controls and observations for those adapters |

Importing the root does not import Drizzle or Cloudflare-specific code.

## Domain boundary

A `FileSystemId` is the immutable identity of one isolated tree. The host maps
either a workspace or an account to it, including an environment component when
environments must not share files.

```ts
const fileSystemId = File.FileSystemIdSchema.make(
  "workspace:01JABC:production",
)
```

Do not derive this value from a mutable slug. Paths, sibling names, file IDs,
command idempotency keys, and ready-byte usage are all isolated by the complete
`FileSystemId`.

The host derives `fileSystemId` and `actor` from authenticated state. Neither
value is accepted from an HTTP body, route, or query string.

Public nodes have one small lifecycle:

```txt
Folder

PendingFile ── confirm actual object within quota ──▶ ReadyFile
     │                                                   │
     └──────────────── tombstone ◀───────────────────────┘
                              │
                              └── bounded R2 reclamation
```

Object locators, signing claims, upload bounds, reclamation state, and command
ledger rows never appear in public nodes.

## Quick start

```ts
import { File, FileSystem } from "@popcomputer/files"
import { layer as inMemoryFiles } from "@popcomputer/files/in-memory"
import { Effect, Layer } from "effect"

const infrastructure = Layer.merge(
  inMemoryFiles(),
  FileSystem.fixedQuotaPolicyLayer(
    FileSystem.byteCount(1024 * 1024 * 1024),
  ),
)

const runtime = FileSystem.layer({
  maximumUploadBytes: FileSystem.byteCount(100 * 1024 * 1024),
}).pipe(Layer.provideMerge(infrastructure))

const program = Effect.gen(function* () {
  const files = yield* FileSystem.FileSystem

  return yield* files.createFolder({
    fileSystemId: File.FileSystemIdSchema.make(
      "workspace:01JABC:production",
    ),
    actor: File.FileActorSchema.make({
      kind: File.FileActorKindSchema.make("user"),
      id: File.FileActorIdSchema.make("user:123"),
    }),
    parentId: null,
    name: File.FileNameSchema.make("documents"),
    idempotencyKey: File.IdempotencyKeySchema.make("folder-documents"),
  })
})

const folder = await Effect.runPromise(
  program.pipe(Effect.provide(runtime)),
)
```

Use `File.parseFileName` and `File.parseRelativePath` for unknown boundary
strings. They NFC-normalize input before returning branded values.

## Folder creation is a durable command

Every `createFolder` call carries a caller-owned idempotency key. An exact replay
returns the original live folder and never allocates a second identity. Reusing
the key with a different parent or name returns `IdempotencyConflict`; replaying
after deletion or metadata purge returns `FolderNoLongerAvailable` with the
original `fileId`.

## Uploads are commands, not mutable rows

Uploads split metadata from bytes:

```txt
requestUpload(idempotency key)
  -> atomically create/replay immutable UploadRequest + PendingFile
  -> issue short-lived bounded PUT capability
  -> client streams bytes directly to R2 data plane
confirmUpload
  -> inspect actual R2 metadata
  -> atomically enforce current quota and mark ReadyFile
```

The D1 upload-request ledger stores the original parent, name, and byte bound.
It is independent of the mutable file row and survives rename, soft deletion,
and file-metadata purging.

- Replaying the original pending command returns the same `fileId` and a fresh
  capability.
- Replaying it after confirmation returns `UploadAlreadyConfirmed`.
- Replaying it after deletion or metadata purge returns
  `UploadNoLongerAvailable`.
- Reusing its key with different input always returns `IdempotencyConflict`.

`confirmUpload` is also idempotent. Quota is resolved from the host-owned
`FileQuotaPolicy` immediately before D1 performs its atomic ready transition.
Changing a plan therefore changes policy without changing tree identity.

`FilesClient.putFile` owns reserve/PUT/confirm under one Effect cancellation
lifetime. It never places the API bearer token on a capability request and
performs no hidden retry. `openBody` is a factory so the caller can decide
whether a body is replayable.

## Declared digests and media types

`requestUpload` accepts an optional `sha256` and `contentType`. Both are signed
into the upload capability. The data plane asks R2 to verify the digest, so
different bytes are never stored (the PUT answers `400`). The signed media type
is recorded whatever the upload request sends. Confirmation fails with
`UploadChecksumMismatch` unless the declared digest is the one observed. The
digest is part of the reservation fingerprint: replaying a key with a different
digest is an `IdempotencyConflict`.

## Host-side bytes

`writeFile` stores bytes the host already holds, such as an email attachment or
a generated report. It reserves under the caller's idempotency key, stores the
bytes create-only with their computed SHA-256, and confirms, all as one
command. A replay returns the ready file; a replay with different bytes is an
`IdempotencyConflict`. `readFile` streams a ready file's bytes to the host
without a capability.

## Moves

`move` moves a file or folder into another folder, renames it, or both. The
whole subtree is rewritten in one guarded statement
([ADR 0007](docs/adr/0007-moves-rewrite-the-subtree-in-one-statement.md)).
Moving a folder into itself fails with `InvalidFileInput("move_into_itself")`.
Every node a move touches gets a strictly later `updatedAt`, so passing
`expectedUpdatedAt` to `move` or `softDelete` makes it conditional; a stale
caller gets `StaleFileNode`.

## Change log

Triggers append every committed change to a folder or ready file to
`popcomputer_file_changes`, in the same transaction
([ADR 0006](docs/adr/0006-triggers-write-the-change-log.md)). The kinds are
`folder_created`, `file_ready`, `node_moved` and `node_deleted`; moving or
deleting a folder reports every visible node in its subtree. Read the log with
`listChanges({ after, limit })` and keep the last `sequence` you processed.
The reclaimer purges entries older than `changeRetentionMillis`.

## HTTP control plane

`makeFilesHttpHandler` is framework-independent. Its authorizer returns a
parsed `{ fileSystemId, actor }` for `read`, `write`, or `delete`.

| Method | Route | Permission |
|---|---|---|
| `GET` | `/files` | `read` |
| `POST` | `/files/folders` | `write` |
| `POST` | `/files/upload-url` | `write` |
| `POST` | `/files/:id/confirm` | `write` |
| `GET` | `/files/:id/download` | `read` |
| `PATCH` | `/files/:id` (`{ name, parentId?, expectedUpdatedAt? }`) | `write` |
| `DELETE` | `/files/:id?expectedUpdatedAt=` | `delete` |

Lists accept `parentId` or `path`, plus keyset `cursor` and `limit`. The
default page size is 50 and the maximum is 100. Mutation bodies reject excess
fields and stream through a 16 KiB cap by default. Error responses contain only
a stable code and safe message; dependency causes and storage details are never
serialized.

`POST /files/folders` and `POST /files/upload-url` require an `Idempotency-Key`
header. Keys are scoped by the complete `FileSystemId` and command kind, so a
folder-create key and upload-reservation key use independent ledgers.

D1 cursors carry their original filesystem, folder, and ordering position. They
cannot be replayed against another filesystem and remain usable if the anchor
node is renamed or deleted between pages.

## D1 is authoritative

Apply `migrations/d1/0001_files.sql` and then
`migrations/d1/0002_file_digests_and_changes.sql` to the adapter database. An installed
package can resolve it with:

```ts
import.meta.resolve("@popcomputer/files/migrations/d1/0001_files.sql")
```

The migration owns three host-neutral tables:

- `popcomputer_files` contains the tree, lifecycle, quota metadata, tombstones,
  and object-reclamation state.
- `popcomputer_file_folder_requests` contains immutable folder-create commands.
- `popcomputer_file_upload_requests` contains immutable idempotent commands.

The D1 adapter owns parent validation, live sibling/path uniqueness,
filesystem isolation, command races, cursor interpretation, quota aggregation,
and atomic lifecycle transitions. Folder creation and upload reservation each
insert their node and immutable request in one transactional D1 batch. The ready
transition and quota guard run in one SQL statement.

R2 is never listed to reconstruct truth. It stores only opaque byte objects.

The package never deletes folder- or upload-request ledger rows while a
filesystem is active. Whole-filesystem retirement is host-owned: first tombstone
the tree, drain object reclamation, purge its file metadata, then delete that
`FileSystemId`'s ledger rows and permanently retire the identifier. Never delete
individual ledger rows to release idempotency keys.

## Cloudflare byte plane

Capability issuance, enforcement, and reclamation use one validated timing
policy:

```ts
import {
  DEFAULT_CLOUDFLARE_FILE_CAPABILITY_POLICY,
  cloudflareFileObjectsLayer,
  makeCloudflareFileDataPlaneHandler,
} from "@popcomputer/files/cloudflare"
import { Redacted } from "effect"

const capabilityPolicy =
  DEFAULT_CLOUDFLARE_FILE_CAPABILITY_POLICY
const signingSecret = Redacted.make(env.FILES_SIGNING_SECRET)

const objects = cloudflareFileObjectsLayer({
  bucket: env.FILES_BUCKET,
  capabilityOrigin: new URL("https://files.example.com"),
  signingSecret,
  capabilityPolicy,
  // Optional: object keys are `{keyPrefix}{uuid}` (default `files/v1/`), and
  // capabilities point at `{origin}{capabilityPath}{token}` (default `/o/`).
  keyPrefix: "tenants/01JABC/files/",
  capabilityPath: "/files-data/o/",
})

const objectHost = makeCloudflareFileDataPlaneHandler({
  bucket: env.FILES_BUCKET,
  signingSecret,
  capabilityPolicy,
  capabilityPath: "/files-data/o/",
  allowedOrigins: ["https://app.example.com"],
})
```

Capabilities are versioned HMAC-SHA256 bearer grants for one object, operation,
and expiry. Uploads are write-once through R2's `etagDoesNotMatch: "*"`
precondition. PUT bodies are byte-metered and aborted at the earlier of token
expiry or the configured maximum upload duration; this deadline is part of the
safe reclamation boundary. The derived reclamation grace covers the longer of
the upload and download safety windows. GET bodies remain streamed and receive
safe attachment headers.

Non-empty PUTs require an accurate `Content-Length`. The handler bridges the
metered body through workerd's fixed-length stream and returns `411` when the
length is absent. Browser `File`/`Blob` and fixed byte bodies naturally provide
one.

Use HTTPS, a signing secret with at least 32 UTF-8 bytes generated from at least
256 bits of randomness, and the shortest practical capability lifetimes. Never
log capability URLs. An issued download remains a bearer credential until it
expires or its object is reclaimed.

## Bounded reclamation

Soft deletion is immediate in the logical tree. Physical deletion is an
explicit operational service:

```ts
import { File, FileReclaimer } from "@popcomputer/files"

const maintenance = FileReclaimer.layer({
  actor: maintenanceActor,
  batchSize: File.MaintenanceBatchSizeSchema.make(50),
  concurrency: 4,
  retryDelayMillis: File.DurationMillisSchema.make(60_000),
  metadataRetentionMillis: File.DurationMillisSchema.make(
    7 * 24 * 60 * 60 * 1000,
  ),
  changeRetentionMillis: File.DurationMillisSchema.make(
    30 * 24 * 60 * 60 * 1000,
  ),
})
```

Run `runBatch()` on a recurring schedule, draining immediately eligible batches
before calling `purgeMetadataBatch()` for the desired tombstone retention and
`purgeChangesBatch()` for the change-log retention. `nextWorkAt()` returns the
earliest instant any of them could make progress, so a host with a single alarm
can set it there instead of polling. An empty pass means no work is eligible at that instant; it does not retire the
schedule, because failed deletions may be waiting for their positive retry
delay.

The reclaimer treats D1 tombstones as a durable outbox:

- expired pending uploads are tombstoned in bounded batches;
- only objects beyond the capability safety boundary are eligible;
- R2 delete is idempotent, so crashes and concurrent workers safely repeat it;
- a failed delete is deferred so it cannot starve the first page;
- metadata is purged only after object reclamation succeeds;
- folder- and upload-request ledger rows remain, so old command keys cannot
  create a second node.

No transaction spans D1 and R2, and none is required for convergence.

## Production composition

Compose the D1 layer, R2 layer, identity source, activity policy, and quota
policy. The same infrastructure can provide both `FileSystem.layer(...)` and
`FileReclaimer.layer(...)`.

A custom `FileIds` source must never reissue a file identity while any folder-
or upload-request ledger retaining it can exist. `randomUuidFileIdsLayer` is the
globally unique production default.

`discardFileActivityLayer` is an explicit policy choice. Replace it with a
host-owned `FileActivitySink` when operational history is required; it remains
best effort and is not a security audit log.

## Deliberate limits

- Folders are always ready; zero-byte files are valid.
- Only live ready bytes consume the logical per-filesystem quota.
- Names are at most 255 and paths at most 1024 Unicode code points; paths
  have at most 32 segments.
- Reclamation retry delays must be positive; metadata retention may be zero.
- Deletion is recursive for a subtree and returns `FileNotFound` on repetition.
- There is no POSIX compatibility surface, multipart upload, range API, full
  text search, version history, generic S3 adapter, or R2-list reconciliation.
- Names, paths, locators, capabilities, credentials, and dependency causes are
  excluded from package logging.

These are scope choices, not placeholders. Add breadth only when a Pop Computer
use-case requires it.

## Verification

```sh
bun run verify
```

The release check runs lint, strict TypeScript, Effect behavior tests, local
SQLite contract tests, real workerd D1/R2 tests, and a packed-tarball consumer
that exercises public declarations, Node ESM imports, migration, documentation,
and license.

## License

MIT
