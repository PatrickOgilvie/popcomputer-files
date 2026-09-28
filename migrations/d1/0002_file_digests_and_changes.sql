-- Declared upload digests: a pending file remembers the SHA-256 its uploader
-- declared, and the upload-request ledger keeps it as part of the command
-- fingerprint so a replay with different bytes is an idempotency conflict.
ALTER TABLE popcomputer_files ADD COLUMN expected_sha256 TEXT
  CONSTRAINT popcomputer_files_expected_sha256_check CHECK (
    expected_sha256 IS NULL
    OR (
      length(expected_sha256) = 64
      AND expected_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE popcomputer_file_upload_requests ADD COLUMN requested_sha256 TEXT
  CONSTRAINT popcomputer_file_upload_requests_sha256_check CHECK (
    requested_sha256 IS NULL
    OR (
      length(requested_sha256) = 64
      AND requested_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

-- A commit-ordered log of visible changes. Triggers write it inside the same
-- transaction as the change, so no committed change is ever missing from it.
-- Folders and ready files are visible; pending uploads never are. The
-- sequence is AUTOINCREMENT so it never goes backwards after a purge.
CREATE TABLE IF NOT EXISTS popcomputer_file_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  file_system_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('folder_created', 'file_ready', 'node_moved', 'node_deleted')
  ),
  file_id TEXT NOT NULL,
  node_kind TEXT NOT NULL CHECK (node_kind IN ('folder', 'file')),
  path TEXT NOT NULL,
  previous_path TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  CONSTRAINT popcomputer_file_changes_previous_path_check CHECK (
    (kind = 'node_moved') = (previous_path IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS popcomputer_file_changes_filesystem_idx
  ON popcomputer_file_changes(file_system_id, sequence);

CREATE INDEX IF NOT EXISTS popcomputer_file_changes_recorded_idx
  ON popcomputer_file_changes(recorded_at, sequence);

CREATE TRIGGER IF NOT EXISTS popcomputer_files_change_folder_created
AFTER INSERT ON popcomputer_files
WHEN NEW.kind = 'folder' AND NEW.deleted_at IS NULL
BEGIN
  INSERT INTO popcomputer_file_changes (
    file_system_id, kind, file_id, node_kind, path, previous_path,
    actor_kind, actor_id, recorded_at
  ) VALUES (
    NEW.file_system_id, 'folder_created', NEW.id, 'folder', NEW.path, NULL,
    NEW.created_actor_kind, NEW.created_actor_id, NEW.created_at
  );
END;

CREATE TRIGGER IF NOT EXISTS popcomputer_files_change_file_ready
AFTER UPDATE OF status ON popcomputer_files
WHEN OLD.status = 'pending'
  AND NEW.status = 'ready'
  AND NEW.deleted_at IS NULL
BEGIN
  INSERT INTO popcomputer_file_changes (
    file_system_id, kind, file_id, node_kind, path, previous_path,
    actor_kind, actor_id, recorded_at
  ) VALUES (
    NEW.file_system_id, 'file_ready', NEW.id, 'file', NEW.path, NULL,
    NEW.updated_actor_kind, NEW.updated_actor_id, NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS popcomputer_files_change_node_moved
AFTER UPDATE OF path ON popcomputer_files
WHEN OLD.path <> NEW.path
  AND NEW.deleted_at IS NULL
  AND (NEW.kind = 'folder' OR NEW.status = 'ready')
BEGIN
  INSERT INTO popcomputer_file_changes (
    file_system_id, kind, file_id, node_kind, path, previous_path,
    actor_kind, actor_id, recorded_at
  ) VALUES (
    NEW.file_system_id, 'node_moved', NEW.id, NEW.kind, NEW.path, OLD.path,
    NEW.updated_actor_kind, NEW.updated_actor_id, NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS popcomputer_files_change_node_deleted
AFTER UPDATE OF deleted_at ON popcomputer_files
WHEN OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NOT NULL
  AND (NEW.kind = 'folder' OR NEW.status = 'ready')
BEGIN
  INSERT INTO popcomputer_file_changes (
    file_system_id, kind, file_id, node_kind, path, previous_path,
    actor_kind, actor_id, recorded_at
  ) VALUES (
    NEW.file_system_id, 'node_deleted', NEW.id, NEW.kind, NEW.path, NULL,
    NEW.deleted_actor_kind, NEW.deleted_actor_id, NEW.deleted_at
  );
END;
