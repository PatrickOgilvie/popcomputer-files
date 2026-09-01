import { Clock, Context, Effect, Layer, Schema } from "effect"
import {
  FileObjects,
  FileReclamationCatalog,
  type FileReclamationCandidate,
} from "./adapter.js"
import type {
  FileCatalogUnavailable,
  InvalidStoredFile,
} from "./errors.js"
import {
  DurationMillisSchema,
  FileActorSchema,
  MaintenanceBatchSizeSchema,
  TimestampMillisSchema,
  type FileId,
  type FileSystemId,
  type MaintenanceBatchSize,
  type TimestampMillis,
} from "./file.js"

const MaintenanceConcurrencySchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 16 }),
)
const ReclamationRetryDelayMillisSchema = DurationMillisSchema.check(
  Schema.isGreaterThan(0),
)

/** Validated policy for one bounded reclamation worker. */
export const FileReclaimerPolicySchema = Schema.Struct({
  actor: FileActorSchema,
  batchSize: MaintenanceBatchSizeSchema,
  concurrency: MaintenanceConcurrencySchema,
  retryDelayMillis: ReclamationRetryDelayMillisSchema,
  metadataRetentionMillis: DurationMillisSchema,
})

/** Validated policy for one bounded reclamation worker. */
export interface FileReclaimerPolicy
  extends Schema.Schema.Type<typeof FileReclaimerPolicySchema> {}

/** Result of attempting to reclaim one tombstoned byte object. */
export type FileReclamationOutcome =
  | {
      readonly _tag: "Reclaimed"
      readonly fileSystemId: FileSystemId
      readonly fileId: FileId
    }
  | {
      readonly _tag: "Deferred"
      readonly fileSystemId: FileSystemId
      readonly fileId: FileId
      readonly retryAt: TimestampMillis
    }

/** Bounded operational report for one reclamation pass. */
export interface FileReclamationReport {
  readonly expiredPending: number
  readonly outcomes: ReadonlyArray<FileReclamationOutcome>
}

/** Operational service that drains D1 tombstones into idempotent object deletes. */
export interface FileReclaimerService {
  readonly runBatch: () => Effect.Effect<
    FileReclamationReport,
    FileCatalogUnavailable | InvalidStoredFile
  >
  readonly purgeMetadataBatch: () => Effect.Effect<
    number,
    FileCatalogUnavailable | InvalidStoredFile
  >
}

/** Effect service tag for bounded file reclamation. */
export class FileReclaimer extends Context.Service<
  FileReclaimer,
  FileReclaimerService
>()("@popcomputer/files/FileReclaimer") {}

const nowMillis = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => TimestampMillisSchema.make(millis)),
)

const addDuration = (
  timestamp: TimestampMillis,
  durationMillis: number,
): TimestampMillis => TimestampMillisSchema.make(timestamp + durationMillis)

const subtractDuration = (
  timestamp: TimestampMillis,
  durationMillis: number,
): TimestampMillis =>
  TimestampMillisSchema.make(Math.max(0, timestamp - durationMillis))

const outcomeIdentity = (candidate: FileReclamationCandidate) => ({
  fileSystemId: candidate.fileSystemId,
  fileId: candidate.fileId,
})

const makeService = Effect.gen(function* () {
  const catalog = yield* FileReclamationCatalog
  const objects = yield* FileObjects
  const policy = yield* FileReclaimerConfiguration

  const reclaim = Effect.fn("FileReclaimer.reclaim")(function* (
    candidate: FileReclamationCandidate,
    now: TimestampMillis,
  ) {
    return yield* Effect.matchEffect(objects.delete(candidate.locator), {
      onFailure: (error) => {
        const retryAt = addDuration(now, policy.retryDelayMillis)
        return Effect.logWarning("file object reclamation deferred", {
          fileSystemId: candidate.fileSystemId,
          fileId: candidate.fileId,
          errorTag: error._tag,
        }).pipe(
          Effect.andThen(
            catalog.deferReclamation({ candidate, retryAt }),
          ),
          Effect.as<FileReclamationOutcome>({
            _tag: "Deferred",
            ...outcomeIdentity(candidate),
            retryAt,
          }),
        )
      },
      onSuccess: () =>
        catalog
          .completeReclamation({ candidate, now })
          .pipe(
            Effect.as<FileReclamationOutcome>({
              _tag: "Reclaimed",
              ...outcomeIdentity(candidate),
            }),
          ),
    })
  })

  const runBatch = Effect.fn("FileReclaimer.runBatch")(function* () {
    const now = yield* nowMillis
    const expiredPending = yield* catalog.expirePendingBatch({
      actor: policy.actor,
      now,
      reclaimAfter: now,
      limit: policy.batchSize,
    })
    const candidates = yield* catalog.listReclaimable({
      now,
      limit: policy.batchSize,
    })
    const outcomes = yield* Effect.forEach(
      candidates,
      (candidate) => reclaim(candidate, now),
      { concurrency: policy.concurrency },
    )
    return { expiredPending, outcomes }
  })

  const purgeMetadataBatch = Effect.fn(
    "FileReclaimer.purgeMetadataBatch",
  )(function* () {
    const now = yield* nowMillis
    return yield* catalog.purgeReclaimedBatch({
      deletedBefore: subtractDuration(
        now,
        policy.metadataRetentionMillis,
      ),
      limit: policy.batchSize,
    })
  })

  return FileReclaimer.of({ runBatch, purgeMetadataBatch })
})

/** Internal Effect service tag for validated reclaimer policy. */
class FileReclaimerConfiguration extends Context.Service<
  FileReclaimerConfiguration,
  FileReclaimerPolicy
>()("@popcomputer/files/FileReclaimerConfiguration") {}

/** Construct a bounded reclaimer from catalog and byte-object adapters. */
export const layer = (
  policy: FileReclaimerPolicy,
): Layer.Layer<
  FileReclaimer,
  never,
  FileReclamationCatalog | FileObjects
> => {
  const validatedPolicy = FileReclaimerPolicySchema.make(policy)
  return Layer.effect(FileReclaimer, makeService).pipe(
    Layer.provide(
      Layer.succeed(FileReclaimerConfiguration, validatedPolicy),
    ),
  )
}

/** Construct a parsed maintenance batch size. */
export const batchSize = (value: number): MaintenanceBatchSize =>
  MaintenanceBatchSizeSchema.make(value)
