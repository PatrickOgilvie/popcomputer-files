# Moves rewrite the subtree in one statement

Every node stores its full path, so moving or renaming a folder must rewrite
the path of every node beneath it. The catalog does this in one guarded
`UPDATE`. A materialized guard is evaluated against the tree as it was before
any row changes. It checks four things:

- the source is still live at the path and instant the caller observed;
- the destination is still a live folder at its observed path;
- no live node owns the new path or name;
- no descendant would exceed 1024 code points or 32 segments.

A move that loses a race changes nothing and is classified afterwards.

Names and paths are measured in Unicode code points, the unit SQLite's
`length()` uses, so the SQL guard and the domain schemas agree exactly. A
move or rename strictly increases `updated_at` on every node it touches, which
makes `updated_at` a sound compare-and-set token for moves and deletes.
Deletion finds its subtree from the node's id at the moment of deletion, never
from a path read earlier, so it cannot follow a node's old location after a
concurrent move.
