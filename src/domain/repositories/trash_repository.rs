use uuid::Uuid;

use crate::common::errors::Result;
use crate::domain::entities::trashed_item::TrashedItem;

pub trait TrashRepository: Send + Sync {
    async fn add_to_trash(&self, item: &TrashedItem) -> Result<()>;
    async fn get_trash_items(&self, user_id: &Uuid) -> Result<Vec<TrashedItem>>;
    async fn get_trash_item(&self, id: &Uuid, user_id: &Uuid) -> Result<Option<TrashedItem>>;
    async fn restore_from_trash(&self, id: &Uuid, user_id: &Uuid) -> Result<()>;
    async fn delete_permanently(&self, id: &Uuid, user_id: &Uuid) -> Result<()>;
    async fn clear_trash(&self, user_id: &Uuid) -> Result<()>;

    /// All trashed file IDs for this user, regardless of parent folder trash status.
    /// Used by empty_trash for thumbnail cleanup — the view used by get_trash_items
    /// excludes files inside trashed folders, which would miss their ext thumbnails.
    async fn get_all_trashed_file_ids(&self, user_id: &Uuid) -> Result<Vec<String>>;

    /// Bulk-delete all expired trash items (files + folders) in a single
    /// transaction.  Returns `(files_deleted, folders_deleted)`.
    async fn delete_expired_bulk(&self) -> Result<(u64, u64)>;
}
