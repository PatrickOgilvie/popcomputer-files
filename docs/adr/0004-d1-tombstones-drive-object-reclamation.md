# D1 tombstones drive object reclamation

Deleted D1 file rows are the durable outbox for bounded, retry-safe R2 deletion.
Reclamation reads eligible locators from D1, performs idempotent object deletes,
and marks completion before metadata is purged; it never lists R2 or attempts a
transaction across D1 and object storage.
