# Upload requests outlive file nodes

Each idempotency key identifies an immutable upload request for the lifetime of
its logical filesystem, so D1 stores that request in a separate ledger instead
of deriving replay from the mutable file row. Renames therefore cannot change
the request fingerprint, deletion cannot release the key, and a replay after
metadata purging reports the original file as unavailable rather than creating
a second file.

The package treats these rows as append-only for the active lifetime of a
`FileSystemId`: adapter operations neither update nor delete them. A host may
delete the complete ledger only as the final step of permanently retiring the
whole logical filesystem, after its tree and byte objects have been drained; the
retired identifier must never be reused.
