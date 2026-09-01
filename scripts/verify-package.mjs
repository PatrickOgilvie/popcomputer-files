import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const repository = process.cwd()
const consumer = mkdtempSync(join(tmpdir(), "popcomputer-files-consumer-"))

const run = (command, arguments_, cwd) => {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  })
  if (result.status !== 0) {
    throw new Error(
      [result.stdout, result.stderr].filter(Boolean).join("\n"),
    )
  }
  return result.stdout
}

let archivePath
try {
  const packOutput = run(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--offline",
      "--cache",
      "node_modules/.cache/npm",
    ],
    repository,
  )
  const packResult = JSON.parse(packOutput)
  const filename = packResult[0]?.filename
  if (typeof filename !== "string") {
    throw new Error("npm pack did not report an archive filename")
  }
  archivePath = resolve(repository, filename)

  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  )
  run(
    "npm",
    [
      "install",
      archivePath,
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--offline",
      "--cache",
      resolve(repository, "node_modules/.cache/npm"),
      "--no-audit",
      "--no-fund",
    ],
    consumer,
  )

  const consumerModules = join(consumer, "node_modules")
  const effectTarget = join(consumerModules, "effect")
  mkdirSync(dirname(effectTarget), { recursive: true })
  symlinkSync(
    resolve(repository, "node_modules", "effect"),
    effectTarget,
    "junction",
  )

  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'const root = await import("@popcomputer/files"); if (!root.File || !root.FileSystem || !root.FileReclaimer) throw new Error("Effect-only root import failed")',
    ],
    consumer,
  )

  const drizzleTarget = join(consumerModules, "drizzle-orm")
  symlinkSync(
    resolve(repository, "node_modules", "drizzle-orm"),
    drizzleTarget,
    "junction",
  )

  cpSync(
    resolve(repository, "package-tests/public-entries.ts"),
    join(consumer, "public-entries.ts"),
  )
  cpSync(
    resolve(repository, "tests/node-esm-smoke.mjs"),
    join(consumer, "node-esm-smoke.mjs"),
  )
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        strict: true,
        noEmit: true,
        // Drizzle intentionally exposes declarations for optional database
        // drivers that are not part of this consumer. The package's own
        // declarations are checked separately before packing.
        skipLibCheck: true,
      },
      include: ["public-entries.ts"],
    }),
  )

  run(
    process.execPath,
    [resolve(repository, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    consumer,
  )
  run(process.execPath, ["node-esm-smoke.mjs"], consumer)

  const installedManifest = JSON.parse(
    readFileSync(
      join(consumerModules, "@popcomputer/files/package.json"),
      "utf8",
    ),
  )
  if (installedManifest.name !== "@popcomputer/files") {
    throw new Error("Installed package manifest failed")
  }
  const installedPackage = join(consumerModules, "@popcomputer/files")
  for (const relativePath of [
    "migrations/d1/0001_files.sql",
    "docs/architecture.md",
    "docs/adr/0001-separate-metadata-and-bytes.md",
    "docs/adr/0002-one-filesystem-is-one-boundary.md",
    "docs/adr/0003-upload-requests-outlive-file-nodes.md",
    "docs/adr/0004-d1-tombstones-drive-object-reclamation.md",
    "docs/adr/0005-folder-create-requests-outlive-folders.md",
    "CHANGELOG.md",
    "README.md",
    "SECURITY.md",
    "LICENSE",
  ]) {
    const contents = readFileSync(join(installedPackage, relativePath), "utf8")
    if (contents.length === 0) {
      throw new Error(`Packed artifact is empty: ${relativePath}`)
    }
  }
} finally {
  rmSync(consumer, { recursive: true, force: true })
  if (archivePath !== undefined) {
    rmSync(archivePath, { force: true })
  }
}
