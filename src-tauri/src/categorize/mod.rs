pub mod heuristics;
pub mod signals;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const BUILTIN_CATEGORIES: [&str; 6] = ["important", "purchases", "notifications", "newsletters", "promotions", "social"];

pub const THRESHOLD: f32 = 0.6;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reason {
    pub code: String,
    #[serde(default)]
    pub params: BTreeMap<String, String>,
}

impl Reason {
    pub fn new(code: &str) -> Self {
        Self { code: code.to_string(), params: BTreeMap::new() }
    }

    pub fn with(mut self, key: &str, value: impl ToString) -> Self {
        self.params.insert(key.to_string(), value.to_string());
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub category: Option<String>,
    pub source: &'static str,
    pub confidence: f32,
    pub reasons: Vec<Reason>,
}
