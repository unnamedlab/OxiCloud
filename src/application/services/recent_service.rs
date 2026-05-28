use crate::application::dtos::cursor::PageCursor;
use crate::application::dtos::recent_dto::{RecentCursor, RecentItemDto, RecentResourceRow};
use crate::application::ports::recent_ports::{RecentItemsRepositoryPort, RecentItemsUseCase};
use crate::common::errors::{DomainError, ErrorKind, Result};
use crate::domain::services::authorization::ResourceKind;
use crate::infrastructure::repositories::pg::RecentItemsPgRepository;
use std::sync::Arc;
use tracing::info;
use uuid::Uuid;

/// Implementation of the use case for managing recent items.
///
/// Depends on `RecentItemsRepositoryPort` (outbound port) instead
/// of accessing `PgPool` directly, following the hexagonal architecture.
pub struct RecentService {
    repo: Arc<RecentItemsPgRepository>,
    max_recent_items: i32,
}

impl RecentService {
    /// Create a new recent items service
    pub fn new(repo: Arc<RecentItemsPgRepository>, max_recent_items: i32) -> Self {
        Self {
            repo,
            max_recent_items: max_recent_items.clamp(1, 100),
        }
    }
}

impl RecentItemsUseCase for RecentService {
    /// Get recent items for a user
    async fn get_recent_items(
        &self,
        user_id: Uuid,
        limit: Option<i32>,
    ) -> Result<Vec<RecentItemDto>> {
        info!("Getting recent items for user: {}", user_id);
        let limit_value = limit
            .unwrap_or(self.max_recent_items)
            .min(self.max_recent_items);
        let items = self.repo.get_recent_items(user_id, limit_value).await?;
        info!(
            "Retrieved {} recent items for user {}",
            items.len(),
            user_id
        );
        Ok(items)
    }

    /// Record access to an item
    async fn record_item_access(
        &self,
        user_id: Uuid,
        item_id: &str,
        item_type: &str,
    ) -> Result<()> {
        info!(
            "Recording access to {} '{}' for user {}",
            item_type, item_id, user_id
        );

        if item_type != "file" && item_type != "folder" {
            return Err(DomainError::new(
                ErrorKind::InvalidInput,
                "RecentItems",
                "Item type must be 'file' or 'folder'",
            ));
        }

        self.repo.upsert_access(user_id, item_id, item_type).await?;
        self.repo.prune(user_id, self.max_recent_items).await?;

        info!(
            "Successfully recorded access to {} '{}' for user {}",
            item_type, item_id, user_id
        );
        Ok(())
    }

    /// Remove an item from recent
    async fn remove_from_recent(
        &self,
        user_id: Uuid,
        item_id: &str,
        item_type: &str,
    ) -> Result<bool> {
        info!(
            "Removing {} '{}' from recent for user {}",
            item_type, item_id, user_id
        );
        let removed = self.repo.remove_item(user_id, item_id, item_type).await?;
        info!(
            "{} {} '{}' from recent items for user {}",
            if removed {
                "Successfully removed"
            } else {
                "Not found"
            },
            item_type,
            item_id,
            user_id
        );
        Ok(removed)
    }

    /// Clear all recent items
    async fn clear_recent_items(&self, user_id: Uuid) -> Result<()> {
        info!("Clearing all recent items for user {}", user_id);
        self.repo.clear_all(user_id).await?;
        info!("Cleared all recent items for user {}", user_id);
        Ok(())
    }
}

impl RecentService {
    /// No authz needed — recent items are strictly user-scoped; the repository
    /// enforces `WHERE user_id = $1` so users can only see their own entries.
    ///
    /// Returns `(rows, next_cursor_encoded)`.
    pub async fn list_resources_paged(
        &self,
        user_id: Uuid,
        limit: usize,
        cursor: Option<RecentCursor>,
        order_by: &str,
        kinds: Option<&[ResourceKind]>,
        reverse: bool,
    ) -> Result<(Vec<RecentResourceRow>, Option<String>)> {
        // Fetch one extra row to detect whether a next page exists.
        let mut rows = self
            .repo
            .list_resources_paged(
                user_id,
                limit + 1,
                cursor.as_ref(),
                order_by,
                kinds,
                reverse,
            )
            .await?;

        let next_cursor = if rows.len() > limit {
            let last = &rows[limit - 1];
            let c = build_recent_cursor(last, order_by, reverse);
            rows.truncate(limit);
            Some(c.encode())
        } else {
            None
        };

        Ok((rows, next_cursor))
    }
}

/// Build the next-page cursor from the last row of the current page.
/// `reverse` is stored in the cursor so subsequent pages use the same direction.
fn build_recent_cursor(row: &RecentResourceRow, order_by: &str, reverse: bool) -> RecentCursor {
    match order_by {
        "name" => RecentCursor {
            order_by: "name".to_owned(),
            resource_id: row.resource_id,
            sort_str: row.sort_str.clone(), // LOWER(name)
            sort_int: row.sort_int,         // folder_first
            sort_ts: None,
            reverse,
        },
        "type" => RecentCursor {
            order_by: "type".to_owned(),
            resource_id: row.resource_id,
            sort_str: row.sort_str.clone(), // LOWER(name)
            sort_int: row.sort_int,         // type_order
            sort_ts: None,
            reverse,
        },
        "modified_at" => RecentCursor {
            order_by: "modified_at".to_owned(),
            resource_id: row.resource_id,
            sort_str: None,
            sort_int: None,
            sort_ts: row.sort_ts, // modified_at timestamp
            reverse,
        },
        "size" => RecentCursor {
            order_by: "size".to_owned(),
            resource_id: row.resource_id,
            sort_str: None,
            sort_int: row.sort_int, // size in bytes
            sort_ts: None,
            reverse,
        },
        "owner" => RecentCursor {
            order_by: "owner".to_owned(),
            resource_id: row.resource_id,
            sort_str: row.sort_str.clone(), // LOWER(username)
            sort_int: None,
            sort_ts: row.sort_ts, // accessed_at timestamp (secondary)
            reverse,
        },
        _ => RecentCursor {
            // default: accessed_at DESC
            order_by: "accessed_at".to_owned(),
            resource_id: row.resource_id,
            sort_str: None,
            sort_int: None,
            sort_ts: row.sort_ts, // accessed_at timestamp
            reverse,
        },
    }
}
