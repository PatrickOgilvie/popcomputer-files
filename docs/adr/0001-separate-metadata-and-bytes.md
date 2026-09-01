# ADR 0001: Separate metadata from file bytes

- Status: Accepted
- Date: 2026-08-31

## Context

The filesystem needs relational operations—tree traversal, sibling uniqueness,
idempotent reservation, lifecycle state, and quota enforcement—while file bytes
need inexpensive streaming upload and download. Binding both concerns to one
vendor API would leak infrastructure details into the domain and make the core
hard to reuse.

## Decision

The package defines two independent adapter ports:

- `FileCatalog` owns authoritative metadata and atomic state transitions.
- `FileObjects` owns opaque object locations, object inspection, and short-lived
  upload and download capabilities.

`FileSystem` coordinates the two but does not attempt a distributed transaction.
A reservation can therefore remain pending when a byte upload is interrupted;
the caller resumes it with the original idempotency key.

The public model never exposes an object locator. The first production adapters
target D1 for metadata and R2-compatible storage for bytes, while an in-memory
adapter keeps the core independently testable.

## Consequences

- Metadata invariants and quota transitions can be enforced atomically in the
  catalog.
- File bodies travel directly through a narrowly scoped capability data plane.
- The core remains independently testable while the supported production path
  stays deliberately focused on D1 and R2.
- Pending reservations and abandoned objects require an explicit reclamation
  pass; D1 tombstones provide its durable retry state.
- Adapter contract tests are required because no transaction spans both ports.
