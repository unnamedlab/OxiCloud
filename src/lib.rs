#![allow(async_fn_in_trait)]

// Export the main project modules
pub mod application;
pub mod common;
pub mod domain;
pub mod infrastructure;
pub mod interfaces;

// Test-only helpers for #[cfg(integration_tests)] modules across the
// crate (shared pool URL guard + pre-suite cleanup OnceCell).
#[cfg(integration_tests)]
pub mod integration_test_support;

// Common public re-exports
pub use application::services::folder_service::FolderService;
pub use application::services::i18n_application_service::I18nApplicationService;
pub use domain::services::path_service::StoragePath;
pub use infrastructure::services::path_service::PathService;
