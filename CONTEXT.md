# Filesystem

This context owns a small hierarchical filesystem for Pop Computer workspaces
or accounts. D1 is authoritative for identity and lifecycle; R2 holds opaque
bytes addressed only through catalog-owned locators.

## Language

**Logical filesystem**:
One isolated tree of folders and files owned by a workspace or account.
_Avoid_: Namespace, tenant scope

**FileSystemId**:
The immutable host-derived identity of one logical filesystem. It is never a
mutable display name or slug.
_Avoid_: Namespace ID, quota account

**File node**:
A folder, pending file, or ready file recorded in the authoritative tree.
_Avoid_: Blob, object

**Pending file**:
A file node whose direct upload has been reserved but not confirmed.
_Avoid_: Temporary file

**Ready file**:
A file node whose stored byte metadata has been atomically confirmed.
_Avoid_: Uploaded blob

**Upload request**:
The immutable command identified by one idempotency key for the lifetime of a
logical filesystem.
_Avoid_: Retry record

**Folder-create request**:
The immutable command that preserves one folder identity across retries and
outlives deletion or metadata purging. Its idempotency-key namespace is separate
from upload requests.
_Avoid_: Retry record, folder cache

**Object locator**:
An opaque package-private address for bytes in object storage.
_Avoid_: File path, public key

**File capability**:
A short-lived bearer grant for one bounded upload or attachment download.
_Avoid_: Public URL, signed file

**Tombstone**:
A deleted catalog row retained as the durable record that its object still
needs reclamation.
_Avoid_: Trash item

**Reclamation**:
The bounded, retry-safe removal of tombstoned byte objects followed by metadata
purging.
_Avoid_: Garbage collection, R2 sweep

**Quota policy**:
The host-owned current ready-byte limit resolved for one FileSystemId.
_Avoid_: Quota account, storage configuration
