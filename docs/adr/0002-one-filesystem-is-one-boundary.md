# One logical filesystem is one boundary

`FileSystemId` is the immutable key for tree isolation, sibling uniqueness,
command idempotency, and ready-byte quota accounting. The host maps either a
workspace or an account to that identity and resolves its current quota as
policy; mutable slugs, quota-account IDs, and speculative shared quota pools do
not participate in the tree key because changing policy must never move or
re-key filesystem data.

## Consequences

- Separate filesystems never share paths, command keys, or quota usage.
- A plan change changes resolved policy without rewriting the tree.
- A future quota shared by several filesystems will require a distinct quota
  ledger rather than another component in filesystem identity.
