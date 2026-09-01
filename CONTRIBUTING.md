# Contributing

Use Bun 1.3.1 and Node 22 or newer.

```sh
bun install
bun run verify
```

Keep domain and service modules independent of framework and Cloudflare binding
types while preserving the package's deliberate D1/R2 product boundary. Parse
HTTP, persistence, and runtime-hop values at adapter boundaries. Expected
failures belong in Effect's typed error channel, and tests should replace
dependencies only through public service seams.

Changes to catalog behavior must preserve the same laws in D1 and in-memory
adapters. Retry safety requires immutable folder-create and upload commands;
custom `FileIds` implementations must not reissue identities retained by either
command ledger. Cleanup must remain bounded, idempotent, and driven by D1 rather
than R2 listing.
