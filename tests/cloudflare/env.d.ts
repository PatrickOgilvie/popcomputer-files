declare global {
  namespace Cloudflare {
    interface Env {
      readonly FILES_DB: D1Database
      readonly FILES_BUCKET: R2Bucket
      readonly TEST_MIGRATIONS: ReadonlyArray<{
        readonly name: string
        readonly queries: ReadonlyArray<string>
      }>
    }
  }
}

export type CloudflareFilesTestEnvironment = Cloudflare.Env
