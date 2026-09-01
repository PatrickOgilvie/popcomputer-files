# Architecture

`@popcomputer/files` separates the metadata control plane from the byte data
plane.

```txt
authenticated host request
  -> strict HTTP decoder
  -> host authorizer derives FileSystemId + FileActor
  -> FileSystem
       -> FileCatalog (D1 or in-memory)
       -> FileObjects (object inspection + capability issuance)
       -> FileQuotaPolicy (host-owned current limit)
       -> FileIds
       -> FileActivitySink (best effort)

capability request
  -> verify version + HMAC + expiry + operation
  -> require a known upload length
  -> meter bytes and bound upload duration through a fixed-length workerd stream
  -> conditional R2 PUT or streamed R2 GET

scheduled maintenance
  -> FileReclaimer
       -> expire abandoned pending rows in bounded batches
       -> read eligible D1 tombstones
       -> idempotently delete opaque R2 objects
       -> mark completion, then purge metadata in bounded batches
```

The core coordinates policy; adapters own boundary mechanics:

- The catalog owns filesystem-isolated lookup, parent checks, sibling
  uniqueness, cursor interpretation, quota aggregation, and atomic lifecycle
  transitions.
- Separate immutable D1 folder- and upload-request ledgers own idempotency
  independently of mutable node state and eventual metadata purge. Keys are
  scoped by complete filesystem identity and command kind.
- The object adapter owns opaque locators, object metadata, and short-lived
  capabilities. Issuance and the data plane share one capability timing policy.
- The HTTP adapter owns strict request parsing and safe status/error projection.
- The hosted client owns protocol decoding and reserve/PUT/confirm sequencing.

No transaction spans catalog metadata and byte storage. A lost folder-create
response replays to its original identity. A cancelled or failed PUT may leave a
recoverable pending row; replaying the original request with the same
idempotency key resumes from that identity. D1 tombstones form a durable outbox
for the inverse operation, so crashes and concurrent reclaimers converge without
listing object storage.

Download capability issuance is followed by an authoritative liveness recheck.
If deletion wins while the capability is being minted, the grant is suppressed;
if deletion lands afterward, its shared timing policy keeps the object until the
grant expires.
