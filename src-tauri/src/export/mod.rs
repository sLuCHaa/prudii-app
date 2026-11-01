pub mod source;
pub mod names;
pub mod parse;
pub mod render;
pub mod run;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportLabels {
    pub lang: String,
    pub title: String,
    pub search_placeholder: String,
    pub back: String,
    pub to: String,
    pub cc: String,
    pub no_subject: String,
    pub attachments: String,
    pub external_images_note: String,
    pub local_copy_note: String,
    pub local_copy_title: String,
    pub failed_title: String,
    pub incomplete_note: String,
    pub accounts_one: String,
    pub accounts_few: String,
    pub accounts_many: String,
    pub accounts_other: String,
    pub mails_one: String,
    pub mails_few: String,
    pub mails_many: String,
    pub mails_other: String,
    pub empty_folder: String,
    pub no_results: String,
    pub show_more: String,
    pub folder_names: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub folder_ids: Vec<String>,
    pub html: bool,
    pub eml: bool,
    pub include_attachments: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub processed: u32,
    pub total: u32,
    pub local_copy: u32,
    pub failed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub path: String,
    pub exported: u32,
    pub local_copy: u32,
    pub failed: u32,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailOutcome {
    Original,
    LocalCopy,
    Failed,
}

static RUNNING: AtomicBool = AtomicBool::new(false);
pub static CANCEL: AtomicBool = AtomicBool::new(false);

pub struct RunGuard;

impl RunGuard {
    pub fn acquire() -> Option<RunGuard> {
        RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| RunGuard)
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

pub fn export_in_progress() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

pub fn request_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

pub fn take_cancel() -> bool {
    CANCEL.swap(false, Ordering::SeqCst)
}
