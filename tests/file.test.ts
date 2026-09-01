import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import {
  ByteCountSchema,
  FileContentTypeSchema,
  FileNameSchema,
  FileNodeSchema,
  TimestampMillisSchema,
  childPath,
  parseFileName,
  parseRelativePath,
} from "../src/file.js"
import { FileNodeDtoSchema } from "../src/protocol.js"

describe("File domain", () => {
  it.effect("normalizes boundary names and paths to NFC", () =>
    Effect.gen(function* () {
      const name = yield* parseFileName("Cafe\u0301.txt")
      const path = yield* parseRelativePath("documents/Cafe\u0301.txt")

      expect(name).toBe("Caf\u00e9.txt")
      expect(path).toBe("documents/Caf\u00e9.txt")
    }),
  )

  it.effect("rejects non-string boundary input as a typed schema failure", () =>
    Effect.gen(function* () {
      const nameError = yield* Effect.flip(parseFileName(42))
      const pathError = yield* Effect.flip(
        parseRelativePath({ path: "docs" }),
      )

      expect(nameError._tag).toBe("SchemaError")
      expect(pathError._tag).toBe("SchemaError")
    }),
  )

  it.effect("rejects traversal, separators, and invalid path depth", () =>
    Effect.gen(function* () {
      const invalidNames = [
        ".",
        "..",
        "../secret",
        "folder/name",
        "folder\\name",
        " trailing",
        "trailing. ",
      ]
      const nameExits = yield* Effect.forEach(invalidNames, (value) =>
        Effect.exit(parseFileName(value)),
      )
      for (const exit of nameExits) {
        expect(Exit.isFailure(exit)).toBe(true)
      }

      const tooDeep = Array.from({ length: 33 }, (_, index) =>
        `segment-${index}`,
      ).join("/")
      const pathExit = yield* Effect.exit(parseRelativePath(tooDeep))
      expect(Exit.isFailure(pathExit)).toBe(true)
    }),
  )

  it.effect("composes validated child paths and accepts zero bytes", () =>
    Effect.gen(function* () {
      const parent = yield* parseRelativePath("documents/reports")
      const leaf = yield* parseFileName("empty.txt")
      const path = yield* childPath(parent, leaf)
      const zero = yield* Schema.decodeUnknownEffect(ByteCountSchema)(0)

      expect(path).toBe("documents/reports/empty.txt")
      expect(zero).toBe(0)
    }),
  )

  it.effect("requires ready-file metadata in the public state machine", () =>
    Effect.gen(function* () {
      const invalidReady = yield* Effect.exit(
        Schema.decodeUnknownEffect(FileNodeSchema)({
          _tag: "ReadyFile",
          id: "file-1",
          parentId: null,
          name: "report.txt",
          path: "report.txt",
          createdAt: 0,
          updatedAt: 0,
          contentType: null,
          digest: null,
        }),
      )

      expect(Exit.isFailure(invalidReady)).toBe(true)
    }),
  )

  it("rejects malformed Unicode, unsafe media types, and unrepresentable dates", () => {
    expect(
      Schema.is(FileNameSchema)(String.fromCharCode(0xd800)),
    ).toBe(false)
    expect(Schema.is(FileContentTypeSchema)("text/plain; charset=utf-8")).toBe(
      true,
    )
    expect(Schema.is(FileContentTypeSchema)("text/😀")).toBe(false)
    expect(Schema.is(ByteCountSchema)(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
    expect(Schema.is(TimestampMillisSchema)(8_640_000_000_000_001)).toBe(false)

    expect(
      Schema.is(FileNodeDtoSchema)({
        id: "file-1",
        parentId: null,
        name: "report.txt",
        path: "report.txt",
        createdAt: "1960-01-01T00:00:00.000Z",
        updatedAt: "1960-01-01T00:00:00.000Z",
        kind: "folder",
        status: "ready",
        size: null,
        contentType: null,
        digest: null,
      }),
    ).toBe(false)
  })
})
