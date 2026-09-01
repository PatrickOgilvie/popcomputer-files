import { Context, Effect } from "effect"
import type {
  FileActivity,
  FileObjectLocator,
  FileObjectMetadata,
  IssuedFileCapability,
  StoredFileNode,
} from "./adapter.js"
import type {
  ByteCount,
  FileId,
  FileName,
  FileSystemId,
} from "./file.js"

/** Object metadata installed at the byte-storage seam by a behavior test. */
export interface TestFileObjectInput extends FileObjectMetadata {
  readonly fileSystemId: FileSystemId
  readonly fileId: FileId
}

/** Capability issuance observed through the in-memory byte-storage seam. */
export type TestIssuedFileCapability =
  | {
      readonly _tag: "Upload"
      readonly locator: FileObjectLocator
      readonly maximumBytes: ByteCount
      readonly capability: IssuedFileCapability
    }
  | {
      readonly _tag: "Download"
      readonly locator: FileObjectLocator
      readonly fileName: FileName
      readonly capability: IssuedFileCapability
    }

/** Test controls and observations backed by the same state as in-memory adapters. */
export interface FileTestControlService {
  readonly putObject: (input: TestFileObjectInput) => Effect.Effect<void>
  readonly removeObject: (
    fileSystemId: FileSystemId,
    fileId: FileId,
  ) => Effect.Effect<void>
  readonly objectExists: (
    fileSystemId: FileSystemId,
    fileId: FileId,
  ) => Effect.Effect<boolean>
  readonly liveNodes: (
    fileSystemId: FileSystemId,
  ) => Effect.Effect<ReadonlyArray<StoredFileNode>>
  readonly deletedNodes: (
    fileSystemId: FileSystemId,
  ) => Effect.Effect<ReadonlyArray<StoredFileNode>>
  readonly reclaimedNodes: (
    fileSystemId: FileSystemId,
  ) => Effect.Effect<ReadonlyArray<StoredFileNode>>
  readonly activities: () => Effect.Effect<ReadonlyArray<FileActivity>>
  readonly issuedCapabilities: () => Effect.Effect<
    ReadonlyArray<TestIssuedFileCapability>
  >
  readonly failNextActivity: () => Effect.Effect<void>
  readonly failNextObjectDelete: () => Effect.Effect<void>
  readonly objectDeleteAttempts: () => Effect.Effect<
    ReadonlyArray<FileObjectLocator>
  >
}

/** Effect service exposing deterministic controls for the in-memory adapters. */
export class FileTestControl extends Context.Service<
  FileTestControl,
  FileTestControlService
>()("@popcomputer/files/FileTestControl") {}
