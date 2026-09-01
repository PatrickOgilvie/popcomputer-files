# Security policy

## Reporting a vulnerability

Please use GitHub private vulnerability reporting in the repository's
**Security** tab. If that channel is unavailable, open an issue asking for a
private contact channel without including exploit details, credentials,
capability URLs, tenant identifiers, or file contents.

## Deployment responsibilities

`@popcomputer/files` supplies filesystem policy, storage adapters, and bounded
reclamation primitives. The host remains responsible for authentication,
authorization, rate limiting, secret rotation, access-log redaction, and
scheduling the package reclaimer on a recurring cadence. An empty pass does not
retire that schedule because deferred deletions may not yet be eligible.

Treat upload and download URLs as bearer credentials. Keep capability and API
origins on HTTPS, and ensure any TLS terminator redirects or rejects cleartext
control-plane ingress before it reaches the package handler. Generate the
signing secret from at least 256 bits of randomness, use the shortest practical
capability lifetime, and never record capability URLs in logs or analytics.

Folder- and upload-request rows retain original requested names for the lifetime
of a logical filesystem. When the host permanently retires a workspace or
account, it must drain reclamation and remove both complete filesystem ledgers as
part of its data-retention workflow; deleting individual rows would break
idempotency.

The resolved quota limits live ready bytes in one logical filesystem. It is not
a physical object-storage cost ceiling: abandoned and deleted objects remain
billable until scheduled reclamation succeeds. Use the same validated
capability timing policy in the R2 issuer and data-plane handler so the reclaimer
never races a still-running upload or an unexpired download capability.
