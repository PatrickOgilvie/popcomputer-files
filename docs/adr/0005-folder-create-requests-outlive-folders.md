# Folder-create requests outlive folders

Each folder-create idempotency key identifies one immutable command for the
lifetime of its logical filesystem. D1 stores the original parent, name, and
allocated file identity in a separate append-only ledger, atomically with the
folder node. A lost response can therefore replay to the same live folder;
changed input conflicts; deletion and metadata purging cannot release the key or
allocate a second identity.

Folder-create and upload-reservation keys occupy separate command-kind
namespaces. Both are additionally scoped by the complete `FileSystemId`, so the
same textual key may intentionally identify one folder command and one upload
command without coupling their lifecycles.

The package never updates or deletes individual folder-request rows. A host may
delete the complete folder and upload ledgers only after draining the tree and
byte objects as the final step of permanently retiring a `FileSystemId`; that
identifier must never be reused.
