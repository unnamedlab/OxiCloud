use uuid::Uuid;

use crate::domain::services::path_service::{StoragePath, validate_storage_name};

// Re-export entity errors from the centralized module
pub use super::entity_errors::{FileError, FileResult};

/// Owned parts of a [`File`] entity, produced by [`File::into_parts()`].
///
/// Consuming a `File` into `FileParts` **moves** every field without cloning,
/// eliminating 3-5 heap allocations that previously occurred when converting
/// `File → FileDto` via `.to_string()` on each getter.
pub struct FileParts {
    pub id: String,
    pub name: String,
    pub storage_path: StoragePath,
    pub path_string: String,
    pub size: u64,
    pub mime_type: String,
    pub folder_id: Option<String>,
    pub created_at: u64,
    pub modified_at: u64,
    pub owner_id: Option<Uuid>,
    /// BLAKE3 content hash. See [`File::content_hash`] for semantics.
    pub blob_hash: String,
}

/**
 * Represents a file in the system's domain model.
 *
 * The File entity is a core domain object that encapsulates all properties and behaviors
 * of a file in the system. It implements an immutable design pattern where modification
 * operations return new instances rather than modifying the existing one.
 *
 * This entity maintains both physical storage information and logical metadata about files,
 * serving as the bridge between the storage system and the application.
 */
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct File {
    /// Unique identifier for the file - used throughout the system for file operations
    id: String,

    /// Name of the file including extension
    name: String,

    /// Path to the file in the domain model
    storage_path: StoragePath,

    /// String representation of the path for API compatibility
    path_string: String,

    /// Size of the file in bytes
    size: u64,

    /// MIME type of the file (e.g., "text/plain", "image/jpeg")
    mime_type: String,

    /// Parent folder ID if the file is within a folder, None if in root
    folder_id: Option<String>,

    /// Creation timestamp (seconds since UNIX epoch)
    created_at: u64,

    /// Last modification timestamp (seconds since UNIX epoch)
    modified_at: u64,

    /// Owner user ID (from storage.files.user_id)
    owner_id: Option<Uuid>,

    /// BLAKE3 content hash. Stable across renames/moves, changes only
    /// when the file's content bytes change. Source of truth for both
    /// content-addressable storage and the HTTP ETag (via
    /// [`File::etag`]). Exposed publicly via [`File::content_hash`]
    /// so the REST API can surface it as a distinct concept from the
    /// ETag (the ETag formula may grow to include `modified_at` etc.,
    /// but `content_hash` remains the raw hash).
    blob_hash: String,
}

// We no longer need this module, now we use a String directly

impl Default for File {
    fn default() -> Self {
        Self {
            id: "stub-id".to_string(),
            name: "stub-file.txt".to_string(),
            storage_path: StoragePath::from_string("/"),
            path_string: "/".to_string(),
            size: 0,
            mime_type: "application/octet-stream".to_string(),
            folder_id: None,
            created_at: 0,
            modified_at: 0,
            owner_id: None,
            blob_hash: String::new(),
        }
    }
}

impl File {
    /// Creates a new file with validation
    pub fn new(
        id: String,
        name: String,
        storage_path: StoragePath,
        size: u64,
        mime_type: String,
        folder_id: Option<String>,
    ) -> FileResult<Self> {
        if let Err(reason) = validate_storage_name(&name) {
            return Err(FileError::InvalidFileName(format!("{name}: {reason}")));
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Store the path string for serialization compatibility
        let path_string = storage_path.to_string();

        Ok(Self {
            id,
            name,
            storage_path,
            path_string,
            size,
            mime_type,
            folder_id,
            created_at: now,
            modified_at: now,
            owner_id: None,
            blob_hash: String::new(),
        })
    }

    /// Creates a folder entity
    pub fn new_folder(
        id: String,
        name: String,
        storage_path: StoragePath,
        parent_id: Option<String>,
        created_at: u64,
        modified_at: u64,
    ) -> FileResult<Self> {
        if let Err(reason) = validate_storage_name(&name) {
            return Err(FileError::InvalidFileName(format!("{name}: {reason}")));
        }

        // Store the path string for serialization compatibility
        let path_string = storage_path.to_string();

        Ok(Self {
            id,
            name,
            storage_path,
            path_string,
            size: 0,                            // Folders have zero size
            mime_type: "directory".to_string(), // Standard MIME type for directories
            folder_id: parent_id,
            created_at,
            modified_at,
            owner_id: None,
            blob_hash: String::new(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_timestamps(
        id: String,
        name: String,
        storage_path: StoragePath,
        size: u64,
        mime_type: String,
        folder_id: Option<String>,
        created_at: u64,
        modified_at: u64,
        owner_id: Option<Uuid>,
    ) -> FileResult<Self> {
        Self::with_timestamps_and_blob_hash(
            id,
            name,
            storage_path,
            size,
            mime_type,
            folder_id,
            created_at,
            modified_at,
            owner_id,
            String::new(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_timestamps_and_blob_hash(
        id: String,
        name: String,
        storage_path: StoragePath,
        size: u64,
        mime_type: String,
        folder_id: Option<String>,
        created_at: u64,
        modified_at: u64,
        owner_id: Option<Uuid>,
        blob_hash: String,
    ) -> FileResult<Self> {
        if let Err(reason) = validate_storage_name(&name) {
            return Err(FileError::InvalidFileName(format!("{name}: {reason}")));
        }

        // Store the path string for serialization compatibility
        let path_string = storage_path.to_string();

        Ok(Self {
            id,
            name,
            storage_path,
            path_string,
            size,
            mime_type,
            folder_id,
            created_at,
            modified_at,
            owner_id,
            blob_hash,
        })
    }

    /// Consume the entity and return all fields by ownership.
    ///
    /// Use this when converting `File` into a DTO to avoid cloning
    /// every `String` field (saves 3-5 heap allocations per file).
    pub fn into_parts(self) -> FileParts {
        FileParts {
            id: self.id,
            name: self.name,
            storage_path: self.storage_path,
            path_string: self.path_string,
            size: self.size,
            mime_type: self.mime_type,
            folder_id: self.folder_id,
            created_at: self.created_at,
            modified_at: self.modified_at,
            owner_id: self.owner_id,
            blob_hash: self.blob_hash,
        }
    }

    /// Raw BLAKE3 content hash — the cryptographic identity of the
    /// file's bytes. Stable across renames, moves, and metadata
    /// updates. Changes only when the underlying content changes.
    ///
    /// This is **distinct from [`File::etag`]**: the ETag is an HTTP
    /// cache token that may incorporate non-content signals (mtime,
    /// permissions, …) in future revisions; `content_hash` is the
    /// raw hash, suitable for content-addressable URLs, dedup
    /// verification, and integrity audits. Keep both accessible —
    /// the API layer can choose to expose `content_hash` even when
    /// `etag` grows additional inputs.
    pub fn content_hash(&self) -> &str {
        &self.blob_hash
    }

    /// Opaque HTTP ETag string (raw, NOT HTTP-quoted). Handlers wrap
    /// in `"…"` themselves at the HTTP boundary.
    ///
    /// **Current formula**: equal to [`File::content_hash`] —
    /// content-addressable BLAKE3. Stable across renames, changes on
    /// every content write. Every handler that emits a file ETag
    /// header MUST route through this method (or the matching
    /// [`FileDto::etag`] field populated from it) so `GET`, `HEAD`,
    /// `PROPFIND`, `PUT` response, and `MOVE` all return
    /// byte-identical values for the same file.
    ///
    /// A follow-up PR will fold `modified_at` into the formula
    /// (`{blob_hash[..16]}-{modified_at}`) so a `x-oc-mtime`-only
    /// update (NextCloud preserves client mtime) invalidates client
    /// caches even when the content bytes are unchanged. At that
    /// point `etag()` and `content_hash()` diverge — that is the
    /// reason they are exposed as two separate methods today.
    pub fn etag(&self) -> &str {
        self.content_hash()
    }

    // Getters
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn storage_path(&self) -> &StoragePath {
        &self.storage_path
    }

    pub fn path_string(&self) -> &str {
        &self.path_string
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn mime_type(&self) -> &str {
        &self.mime_type
    }

    pub fn folder_id(&self) -> Option<&str> {
        self.folder_id.as_deref()
    }

    pub fn created_at(&self) -> u64 {
        self.created_at
    }

    pub fn modified_at(&self) -> u64 {
        self.modified_at
    }

    pub fn owner_id(&self) -> Option<Uuid> {
        self.owner_id
    }

    #[allow(clippy::too_many_arguments)]
    pub fn from_dto(
        id: String,
        name: String,
        path: String,
        size: u64,
        mime_type: String,
        folder_id: Option<String>,
        created_at: u64,
        modified_at: u64,
    ) -> Self {
        // Create storage_path from string
        let storage_path = StoragePath::from_string(&path);

        // Create directly without validation to avoid errors in DTO conversions
        Self {
            id,
            name,
            storage_path,
            path_string: path,
            size,
            mime_type,
            folder_id,
            created_at,
            modified_at,
            owner_id: None,
            blob_hash: String::new(),
        }
    }

    // Methods to create new versions of the file (immutable)

    /// Creates a new version of the file with updated name
    pub fn with_name(&self, new_name: String) -> FileResult<Self> {
        if let Err(reason) = validate_storage_name(&new_name) {
            return Err(FileError::InvalidFileName(format!("{new_name}: {reason}")));
        }

        // Update path based on name
        let parent_path = self.storage_path.parent();
        let new_storage_path = match parent_path {
            Some(parent) => parent.join(&new_name),
            None => StoragePath::from_string(&new_name),
        };

        // Update string representation
        let new_path_string = new_storage_path.to_string();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        Ok(Self {
            id: self.id.clone(),
            name: new_name,
            storage_path: new_storage_path,
            path_string: new_path_string,
            size: self.size,
            mime_type: self.mime_type.clone(),
            folder_id: self.folder_id.clone(),
            created_at: self.created_at,
            modified_at: now,
            owner_id: self.owner_id,
            blob_hash: self.blob_hash.clone(),
        })
    }

    /// Creates a new version of the file with updated folder
    pub fn with_folder(
        &self,
        folder_id: Option<String>,
        folder_path: Option<StoragePath>,
    ) -> FileResult<Self> {
        // We need a folder path to update the file path
        let new_storage_path = match folder_path {
            Some(path) => path.join(&self.name),
            None => StoragePath::from_string(&self.name), // Root
        };

        // Update string representation
        let new_path_string = new_storage_path.to_string();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        Ok(Self {
            id: self.id.clone(),
            name: self.name.clone(),
            storage_path: new_storage_path,
            path_string: new_path_string,
            size: self.size,
            mime_type: self.mime_type.clone(),
            folder_id,
            created_at: self.created_at,
            modified_at: now,
            owner_id: self.owner_id,
            blob_hash: self.blob_hash.clone(),
        })
    }

    /// Creates a new version of the file with updated size
    pub fn with_size(&self, new_size: u64) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        Self {
            id: self.id.clone(),
            name: self.name.clone(),
            storage_path: self.storage_path.clone(),
            path_string: self.path_string.clone(),
            size: new_size,
            mime_type: self.mime_type.clone(),
            folder_id: self.folder_id.clone(),
            created_at: self.created_at,
            modified_at: now,
            owner_id: self.owner_id,
            blob_hash: self.blob_hash.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_file_creation_with_valid_name() {
        let storage_path = StoragePath::from_string("/test/file.txt");
        let file = File::new(
            "123".to_string(),
            "file.txt".to_string(),
            storage_path,
            100,
            "text/plain".to_string(),
            None,
        );

        assert!(file.is_ok());
    }

    #[test]
    fn test_file_creation_with_invalid_name() {
        let storage_path = StoragePath::from_string("/test/invalid/file.txt");
        let file = File::new(
            "123".to_string(),
            "file/with/slash.txt".to_string(), // Invalid name
            storage_path,
            100,
            "text/plain".to_string(),
            None,
        );

        assert!(file.is_err());
        match file {
            Err(FileError::InvalidFileName(_)) => (),
            _ => panic!("Expected InvalidFileName error"),
        }
    }

    #[test]
    fn test_file_with_name() {
        let storage_path = StoragePath::from_string("/test/file.txt");
        let file = File::new(
            "123".to_string(),
            "file.txt".to_string(),
            storage_path,
            100,
            "text/plain".to_string(),
            None,
        )
        .unwrap();

        let renamed = file.with_name("newname.txt".to_string());
        assert!(renamed.is_ok());
        let renamed = renamed.unwrap();
        assert_eq!(renamed.name(), "newname.txt");
        assert_eq!(renamed.id(), "123"); // The ID does not change
    }

    /// Today `etag()` and `content_hash()` return the same string
    /// (the v1 formula is identity); the test exists to catch a
    /// future change that accidentally lets them disagree when they
    /// should match. PR 2 will deliberately make them diverge.
    #[test]
    fn test_etag_currently_equals_content_hash() {
        let file = File::with_timestamps_and_blob_hash(
            "id-1".to_string(),
            "file.txt".to_string(),
            StoragePath::from_string("/file.txt"),
            42,
            "text/plain".to_string(),
            None,
            1_000,
            2_000,
            None,
            "abcdef0123456789".to_string(),
        )
        .unwrap();

        assert_eq!(file.content_hash(), "abcdef0123456789");
        assert_eq!(file.etag(), file.content_hash());
    }

    /// Renames must NOT change the content identity. Both `etag()`
    /// and `content_hash()` are derived from `blob_hash`, which is
    /// preserved across `with_name`. If a future refactor drops
    /// `blob_hash` from the rename builder, this test catches it.
    #[test]
    fn test_etag_stable_across_rename() {
        let file = File::with_timestamps_and_blob_hash(
            "id-1".to_string(),
            "file.txt".to_string(),
            StoragePath::from_string("/file.txt"),
            42,
            "text/plain".to_string(),
            None,
            1_000,
            2_000,
            None,
            "stable-hash".to_string(),
        )
        .unwrap();

        let renamed = file.with_name("renamed.txt".to_string()).unwrap();
        assert_eq!(renamed.etag(), "stable-hash");
        assert_eq!(renamed.content_hash(), "stable-hash");
    }
}
