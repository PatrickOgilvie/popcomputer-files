# Triggers write the change log

Hosts need to react to files arriving, moving and leaving — to index them,
parse them or route them — without polling the tree. Every committed change to
a visible node is therefore appended to `popcomputer_file_changes` by SQLite
triggers on `popcomputer_files`, inside the same transaction as the change. No
code path can commit a change and forget its entry, and no entry exists for a
change that rolled back.

Visible nodes are folders and ready files. Pending uploads never appear: a file
is first reported as `file_ready` at the path it has at that moment, and an
abandoned upload leaves no trace. Moving or deleting a folder reports every
visible node in its subtree, so a consumer never has to expand a folder change
itself; entries from one statement share an instant, and their order among
themselves is the store's row order.

The sequence is `AUTOINCREMENT`, so it never goes backwards after the oldest
entries are purged, and a consumer's cursor stays valid. Retention is the
reclaimer's policy. A consumer that falls further behind than the retention
must rescan the tree.
