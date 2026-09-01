import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import {
  FileSystem,
  fixedQuotaPolicyLayer,
  layer as fileSystemLayer,
} from "../src/file-system.js"
import {
  ByteCountSchema,
  DurationMillisSchema,
  FileActorIdSchema,
  FileActorKindSchema,
  FileActorSchema,
  FileNameSchema,
  FileSystemIdSchema,
  IdempotencyKeySchema,
} from "../src/file.js"
import { layer as inMemoryLayer } from "../src/in-memory.js"
import {
  FileReclaimer,
  FileReclaimerPolicySchema,
  batchSize,
  layer as reclaimerLayer,
} from "../src/reclaimer.js"
import { FileTestControl } from "../src/testing.js"

const actor = FileActorSchema.make({
  kind: FileActorKindSchema.make("system"),
  id: FileActorIdSchema.make("file-reclaimer"),
})
const fileSystemId = FileSystemIdSchema.make("reclaimer-test")
const bytes = (value: number) => ByteCountSchema.make(value)
const name = (value: string) => FileNameSchema.make(value)
const key = (value: string) => IdempotencyKeySchema.make(value)

const infrastructure = Layer.merge(
  inMemoryLayer(),
  fixedQuotaPolicyLayer(bytes(1_000)),
)
const policy = FileReclaimerPolicySchema.make({
  actor,
  batchSize: batchSize(2),
  concurrency: 2,
  retryDelayMillis: DurationMillisSchema.make(1_000),
  metadataRetentionMillis: DurationMillisSchema.make(0),
})
const runtimeLayer = Layer.merge(
  fileSystemLayer({ maximumUploadBytes: bytes(100) }),
  reclaimerLayer(policy),
).pipe(Layer.provideMerge(infrastructure))

const request = (index: number) => ({
  fileSystemId,
  actor,
  parentId: null,
  name: name(`pending-${index}.bin`),
  size: bytes(1),
  idempotencyKey: key(`pending-${index}`),
})

describe("in-memory FileReclaimer", () => {
  it("rejects invalid worker concurrency at layer construction", () => {
    expect(() => reclaimerLayer({ ...policy, concurrency: 0 })).toThrow()
    expect(() => reclaimerLayer({ ...policy, concurrency: 17 })).toThrow()
    expect(() =>
      reclaimerLayer({
        ...policy,
        retryDelayMillis: DurationMillisSchema.make(0),
      }),
    ).toThrow()
  })

  it.effect("expires and reclaims pending uploads in bounded batches", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const reclaimer = yield* FileReclaimer
      const controls = yield* FileTestControl
      const tickets = []

      for (const index of [1, 2, 3]) {
        const ticket = yield* files.requestUpload(request(index))
        tickets.push(ticket)
        yield* controls.putObject({
          fileSystemId,
          fileId: ticket.fileId,
          size: bytes(1),
          contentType: null,
          digest: null,
        })
      }

      yield* TestClock.adjust(5 * 60 * 1_000)

      const first = yield* reclaimer.runBatch()
      expect(first.expiredPending).toBe(2)
      expect(first.outcomes.map((outcome) => outcome._tag)).toEqual([
        "Reclaimed",
        "Reclaimed",
      ])
      const [firstTicket, secondTicket, thirdTicket] = tickets
      if (
        firstTicket === undefined ||
        secondTicket === undefined ||
        thirdTicket === undefined
      ) {
        return yield* Effect.die("expected three upload tickets")
      }
      expect(yield* controls.objectExists(fileSystemId, firstTicket.fileId))
        .toBe(false)
      expect(yield* controls.objectExists(fileSystemId, secondTicket.fileId))
        .toBe(false)
      expect(yield* controls.objectExists(fileSystemId, thirdTicket.fileId))
        .toBe(true)

      const second = yield* reclaimer.runBatch()
      expect(second.expiredPending).toBe(1)
      expect(second.outcomes.map((outcome) => outcome._tag)).toEqual([
        "Reclaimed",
      ])

      const attempts = yield* controls.objectDeleteAttempts()
      const repeated = yield* reclaimer.runBatch()
      expect(repeated).toEqual({ expiredPending: 0, outcomes: [] })
      expect(yield* controls.objectDeleteAttempts()).toEqual(attempts)
    }).pipe(Effect.provide(runtimeLayer)),
  )

  it.effect("defers failed deletion, retries once, and retains replay identity after purge", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem
      const reclaimer = yield* FileReclaimer
      const controls = yield* FileTestControl
      const uploadRequest = request(10)
      const ticket = yield* files.requestUpload(uploadRequest)
      yield* controls.putObject({
        fileSystemId,
        fileId: ticket.fileId,
        size: bytes(1),
        contentType: null,
        digest: null,
      })
      yield* files.softDelete({
        fileSystemId,
        actor,
        fileId: ticket.fileId,
      })
      yield* TestClock.adjust(5 * 60 * 1_000)
      yield* controls.failNextObjectDelete()

      const deferred = yield* reclaimer.runBatch()
      expect(deferred.expiredPending).toBe(0)
      expect(deferred.outcomes.map((outcome) => outcome._tag)).toEqual([
        "Deferred",
      ])
      expect(yield* controls.objectExists(fileSystemId, ticket.fileId)).toBe(
        true,
      )
      expect(yield* controls.reclaimedNodes(fileSystemId)).toEqual([])

      expect((yield* reclaimer.runBatch()).outcomes).toEqual([])
      yield* TestClock.adjust(1_000)

      const retried = yield* reclaimer.runBatch()
      expect(retried.outcomes.map((outcome) => outcome._tag)).toEqual([
        "Reclaimed",
      ])
      expect(yield* controls.objectExists(fileSystemId, ticket.fileId)).toBe(
        false,
      )
      expect(yield* controls.reclaimedNodes(fileSystemId)).toHaveLength(1)
      expect(yield* controls.objectDeleteAttempts()).toHaveLength(2)

      expect(yield* reclaimer.purgeMetadataBatch()).toBe(1)
      expect(yield* controls.deletedNodes(fileSystemId)).toEqual([])
      const unavailable = yield* Effect.flip(
        files.requestUpload(uploadRequest),
      )
      expect(unavailable._tag).toBe("UploadNoLongerAvailable")
      if (unavailable._tag === "UploadNoLongerAvailable") {
        expect(unavailable.fileId).toBe(ticket.fileId)
      }

      yield* reclaimer.runBatch()
      expect(yield* controls.objectDeleteAttempts()).toHaveLength(2)
    }).pipe(Effect.provide(runtimeLayer)),
  )
})
