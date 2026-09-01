CREATE TABLE IF NOT EXISTS popcomputer_files (
  file_system_id TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  locator TEXT,
  maximum_bytes INTEGER,
  pending_expires_at INTEGER,
  size INTEGER,
  content_type TEXT,
  digest_kind TEXT CHECK (digest_kind IS NULL OR digest_kind IN ('sha256', 'opaque_etag')),
  digest_value TEXT,
  created_actor_kind TEXT NOT NULL,
  created_actor_id TEXT NOT NULL,
  updated_actor_kind TEXT NOT NULL,
  updated_actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_actor_kind TEXT,
  deleted_actor_id TEXT,
  reclaim_after INTEGER,
  object_reclaimed_at INTEGER,
  CONSTRAINT popcomputer_files_pk PRIMARY KEY (file_system_id, id),
  CONSTRAINT popcomputer_files_parent_fk
    FOREIGN KEY (file_system_id, parent_id)
    REFERENCES popcomputer_files(file_system_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT popcomputer_files_identity_check CHECK (
    length(file_system_id) BETWEEN 1 AND 200
    AND length(id) BETWEEN 1 AND 200
    AND (parent_id IS NULL OR parent_id <> id)
  ),
  CONSTRAINT popcomputer_files_name_path_check CHECK (
    length(name) BETWEEN 1 AND 255
    AND length(path) BETWEEN 1 AND 1024
    AND (path = name OR substr(path, -(length(name) + 1)) = '/' || name)
  ),
  CONSTRAINT popcomputer_files_time_check CHECK (
    created_at >= 0
    AND updated_at >= created_at
    AND (pending_expires_at IS NULL OR pending_expires_at >= created_at)
    AND (deleted_at IS NULL OR deleted_at >= created_at)
    AND (reclaim_after IS NULL OR reclaim_after >= deleted_at)
    AND (object_reclaimed_at IS NULL OR object_reclaimed_at >= reclaim_after)
  ),
  CONSTRAINT popcomputer_files_deletion_check CHECK (
    (
      deleted_at IS NULL
      AND deleted_actor_kind IS NULL
      AND deleted_actor_id IS NULL
      AND reclaim_after IS NULL
      AND object_reclaimed_at IS NULL
    ) OR (
      deleted_at IS NOT NULL
      AND deleted_actor_kind IS NOT NULL
      AND deleted_actor_id IS NOT NULL
      AND reclaim_after IS NOT NULL
      AND (object_reclaimed_at IS NULL OR locator IS NOT NULL)
    )
  ),
  CONSTRAINT popcomputer_files_digest_check CHECK (
    (digest_kind IS NULL AND digest_value IS NULL)
    OR (
      digest_kind = 'sha256'
      AND digest_value IS NOT NULL
      AND length(digest_value) = 64
      AND digest_value NOT GLOB '*[^0-9a-f]*'
    )
    OR (
      digest_kind = 'opaque_etag'
      AND digest_value IS NOT NULL
      AND length(digest_value) BETWEEN 1 AND 512
    )
  ),
  CONSTRAINT popcomputer_files_lifecycle_check CHECK (
    (
      kind = 'folder'
      AND status = 'ready'
      AND locator IS NULL
      AND maximum_bytes IS NULL
      AND pending_expires_at IS NULL
      AND size IS NULL
      AND content_type IS NULL
      AND digest_kind IS NULL
      AND digest_value IS NULL
    ) OR (
      kind = 'file'
      AND status = 'pending'
      AND locator IS NOT NULL
      AND maximum_bytes IS NOT NULL
      AND typeof(maximum_bytes) = 'integer'
      AND maximum_bytes >= 0
      AND pending_expires_at IS NOT NULL
      AND size IS NULL
      AND content_type IS NULL
      AND digest_kind IS NULL
      AND digest_value IS NULL
    ) OR (
      kind = 'file'
      AND status = 'ready'
      AND locator IS NOT NULL
      AND maximum_bytes IS NOT NULL
      AND typeof(maximum_bytes) = 'integer'
      AND maximum_bytes >= 0
      AND pending_expires_at IS NULL
      AND size IS NOT NULL
      AND typeof(size) = 'integer'
      AND size >= 0
      AND (content_type IS NULL OR length(content_type) BETWEEN 1 AND 255)
    )
  )
);

CREATE TABLE IF NOT EXISTS popcomputer_file_folder_requests (
  file_system_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  file_id TEXT NOT NULL,
  requested_parent_id TEXT,
  requested_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CONSTRAINT popcomputer_file_folder_requests_pk
    PRIMARY KEY (file_system_id, idempotency_key),
  CONSTRAINT popcomputer_file_folder_requests_file_uq
    UNIQUE (file_system_id, file_id),
  CONSTRAINT popcomputer_file_folder_requests_identity_check CHECK (
    length(file_system_id) BETWEEN 1 AND 200
    AND length(idempotency_key) BETWEEN 1 AND 128
    AND length(file_id) BETWEEN 1 AND 200
    AND (requested_parent_id IS NULL OR requested_parent_id <> file_id)
  ),
  CONSTRAINT popcomputer_file_folder_requests_command_check CHECK (
    length(requested_name) BETWEEN 1 AND 255
    AND created_at >= 0
  )
);

CREATE TABLE IF NOT EXISTS popcomputer_file_upload_requests (
  file_system_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  file_id TEXT NOT NULL,
  requested_parent_id TEXT,
  requested_name TEXT NOT NULL,
  requested_maximum_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CONSTRAINT popcomputer_file_upload_requests_pk
    PRIMARY KEY (file_system_id, idempotency_key),
  CONSTRAINT popcomputer_file_upload_requests_file_uq
    UNIQUE (file_system_id, file_id),
  CONSTRAINT popcomputer_file_upload_requests_identity_check CHECK (
    length(file_system_id) BETWEEN 1 AND 200
    AND length(idempotency_key) BETWEEN 1 AND 128
    AND length(file_id) BETWEEN 1 AND 200
    AND (requested_parent_id IS NULL OR requested_parent_id <> file_id)
  ),
  CONSTRAINT popcomputer_file_upload_requests_command_check CHECK (
    length(requested_name) BETWEEN 1 AND 255
    AND typeof(requested_maximum_bytes) = 'integer'
    AND requested_maximum_bytes >= 0
    AND created_at >= 0
  )
);

CREATE TRIGGER IF NOT EXISTS popcomputer_files_validate_parent_insert
BEFORE INSERT ON popcomputer_files
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM popcomputer_files AS parent
    WHERE parent.file_system_id = NEW.file_system_id
      AND parent.id = NEW.parent_id
      AND parent.kind = 'folder'
      AND parent.deleted_at IS NULL
  ) THEN RAISE(ABORT, 'parent must be a live folder in the same filesystem') END;
END;

CREATE TRIGGER IF NOT EXISTS popcomputer_files_validate_parent_update
BEFORE UPDATE OF file_system_id, parent_id ON popcomputer_files
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM popcomputer_files AS parent
    WHERE parent.file_system_id = NEW.file_system_id
      AND parent.id = NEW.parent_id
      AND parent.kind = 'folder'
      AND parent.deleted_at IS NULL
  ) THEN RAISE(ABORT, 'parent must be a live folder in the same filesystem') END;
END;

CREATE TRIGGER IF NOT EXISTS popcomputer_file_upload_requests_immutable
BEFORE UPDATE ON popcomputer_file_upload_requests
BEGIN
  SELECT RAISE(ABORT, 'upload request ledger rows are immutable');
END;

CREATE TRIGGER IF NOT EXISTS popcomputer_file_folder_requests_immutable
BEFORE UPDATE ON popcomputer_file_folder_requests
BEGIN
  SELECT RAISE(ABORT, 'folder request ledger rows are immutable');
END;

CREATE UNIQUE INDEX IF NOT EXISTS popcomputer_files_live_sibling_uq
  ON popcomputer_files(file_system_id, coalesce(parent_id, ''), name)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS popcomputer_files_live_path_uq
  ON popcomputer_files(file_system_id, path)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS popcomputer_files_locator_uq
  ON popcomputer_files(locator)
  WHERE locator IS NOT NULL;

CREATE INDEX IF NOT EXISTS popcomputer_files_children_idx
  ON popcomputer_files(file_system_id, parent_id, kind DESC, name, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS popcomputer_files_quota_idx
  ON popcomputer_files(file_system_id, status, deleted_at);

CREATE INDEX IF NOT EXISTS popcomputer_files_pending_expiry_idx
  ON popcomputer_files(pending_expires_at, file_system_id, id)
  WHERE deleted_at IS NULL AND kind = 'file' AND status = 'pending';

CREATE INDEX IF NOT EXISTS popcomputer_files_reclamation_idx
  ON popcomputer_files(reclaim_after, file_system_id, id)
  WHERE deleted_at IS NOT NULL AND locator IS NOT NULL AND object_reclaimed_at IS NULL;

CREATE INDEX IF NOT EXISTS popcomputer_files_purge_idx
  ON popcomputer_files(deleted_at, file_system_id, id)
  WHERE deleted_at IS NOT NULL;
