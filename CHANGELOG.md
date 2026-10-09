# Changelog

## 0.3.0

- Effect `4.0.2`. The `effect` peer range is now `^4.0.0`, so Effect 4
  release candidates are no longer supported.


## 0.2.0

- **Moves.** `FileSystem.move` replaces `renameFile`: files and folders move
  into another folder, are renamed, or both. The whole subtree is rewritten in
  one guarded statement. An optional `expectedUpdatedAt` makes moves and
  deletes conditional.
- **Declared digests.** `requestUpload` accepts `sha256` and `contentType`,
  and both are signed into the upload capability. R2 rejects bytes with another
  digest, and confirmation requires the declared digest. `stat` reports the
  SHA-256 when R2 holds it.
- **Host bytes.** `FileSystem.writeFile` stores bytes the host already holds,
  as one idempotent command with a computed SHA-256; a replay returns the file.
  `FileSystem.readFile` streams a ready file's bytes. `FileSystem.getNode`
  returns one node.
- **Change log.** Migration `0002` adds `popcomputer_file_changes`, which
  triggers fill with `folder_created`, `file_ready`, `node_moved` and
  `node_deleted` in commit order. `FileSystem.listChanges` reads it. The
  reclaimer purges it after `changeRetentionMillis` and reports `nextWorkAt`
  for one-alarm scheduling.
- **Cloudflare hosting.** `keyPrefix` places objects under a host prefix, and
  `capabilityPath` mounts the data plane anywhere under an origin. Capability
  tokens are now version 2.
- **Limits.** Names and paths are measured in Unicode code points.
- Effect `4.0.0-rc.116`.


## 0.1.0

- Initial public release of the Effect-native logical filesystem, HTTP client
  and handler, in-memory implementation, D1 catalog with immutable folder-create
  and upload ledgers, Cloudflare R2 capability data plane, dynamic quota policy,
  and bounded reclamation service.
