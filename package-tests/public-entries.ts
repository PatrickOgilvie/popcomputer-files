import { File, FileError, FileReclaimer, FileSystem } from "@popcomputer/files"
import {
  FileActivitySink,
  FileCatalog,
  FileIds,
  FileObjects,
  FileReclamationCatalog,
} from "@popcomputer/files/adapter"
import {
  FilesClient,
  layer as filesClientLayer,
  makeFilesClient,
} from "@popcomputer/files/client"
import {
  DEFAULT_CLOUDFLARE_FILE_CAPABILITY_POLICY,
  cloudflareFileObjectsLayer,
  makeCloudflareFileCapabilityPolicy,
  makeCloudflareFileDataPlaneHandler,
  makeCloudflareFileObjects,
} from "@popcomputer/files/cloudflare"
import {
  d1FileCatalogLayer,
  makeD1FileCatalog,
  makeD1FileReclamationCatalog,
} from "@popcomputer/files/d1"
import {
  d1Files,
  d1FileFolderRequests,
  d1FileUploadRequests,
} from "@popcomputer/files/d1/schema"
import {
  FileNodeDtoSchema,
  makeFilesHttpHandler,
} from "@popcomputer/files/http"
import { layer as inMemoryFiles } from "@popcomputer/files/in-memory"
import { FileTestControl } from "@popcomputer/files/testing"
import {
  FileReclaimer as FileReclaimerService,
  FileReclaimerPolicySchema,
  batchSize as reclaimerBatchSize,
  layer as fileReclaimerLayer,
} from "@popcomputer/files/reclaimer"
import { Redacted, Schema } from "effect"

const name = Schema.decodeUnknownSync(File.FileNameSchema)("report.txt")
const bytes = FileSystem.byteCount(3)

const clientOptions = {
  baseUrl: new URL("https://example.com/api/files"),
  apiToken: Redacted.make("secret"),
  fetch: async () => new Response(null, { status: 503 }),
}
const client = makeFilesClient(clientOptions)
const clientLayer = filesClientLayer(clientOptions)

void name
void bytes
void client
void clientLayer
void FilesClient
void File.FileNodeSchema
void File.FileSystemIdSchema
void File.IdempotencyKeySchema
void FileError.FileNotFound
void FileError.FolderNoLongerAvailable
void FileSystem.FileSystem
void FileActivitySink
void FileCatalog
void FileIds
void FileObjects
void FileReclamationCatalog
void FileSystem.FileQuotaPolicy
void FileSystem.fixedQuotaPolicyLayer
void FileReclaimer.FileReclaimer
void FileReclaimer.FileReclaimerPolicySchema
void FileReclaimer.batchSize
void FileReclaimer.layer
void FileReclaimerService
void FileReclaimerPolicySchema
void reclaimerBatchSize
void fileReclaimerLayer
void makeFilesHttpHandler
void FileNodeDtoSchema
void makeCloudflareFileObjects
void cloudflareFileObjectsLayer
void makeCloudflareFileDataPlaneHandler
void makeCloudflareFileCapabilityPolicy
void DEFAULT_CLOUDFLARE_FILE_CAPABILITY_POLICY
void makeD1FileCatalog
void makeD1FileReclamationCatalog
void d1FileCatalogLayer
void d1Files
void d1FileFolderRequests
void d1FileUploadRequests
void inMemoryFiles
void FileTestControl
