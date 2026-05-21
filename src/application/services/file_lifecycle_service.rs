use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::application::ports::file_lifecycle::FileDeletedHook;

/// Composite dispatcher for file lifecycle events.
///
/// Aggregates all `FileDeletedHook` implementations and fans out each event to
/// every registered handler. Services hold a single `Arc<dyn FileDeletedHook>`
/// pointing here — new handlers are added once, in DI, without touching the
/// services themselves.
pub struct FileLifecycleService {
    deleted: Vec<Arc<dyn FileDeletedHook>>,
}

impl Default for FileLifecycleService {
    fn default() -> Self {
        Self::new()
    }
}

impl FileLifecycleService {
    pub fn new() -> Self {
        Self {
            deleted: Vec::new(),
        }
    }

    pub fn with_deleted_hook(mut self, hook: Arc<dyn FileDeletedHook>) -> Self {
        self.deleted.push(hook);
        self
    }
}

impl FileDeletedHook for FileLifecycleService {
    fn on_file_deleted<'a>(
        &'a self,
        file_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            for hook in &self.deleted {
                hook.on_file_deleted(file_id).await;
            }
        })
    }
}
