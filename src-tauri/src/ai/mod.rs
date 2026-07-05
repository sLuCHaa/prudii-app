pub mod prompts;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaModel {
    pub name: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaStatus {
    pub connected: bool,
    pub models: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TagsResponse {
    models: Vec<TagModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TagModel {
    name: String,
    size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GenerateRequest {
    model: String,
    prompt: String,
    stream: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GenerateChunk {
    response: Option<String>,
    done: Option<bool>,
}

pub struct OllamaClient {
    client: Client,
    base_url: String,
}

impl OllamaClient {
    pub fn new(base_url: &str) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_default();

        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    /// Check Ollama status and list available models
    pub async fn check_status(&self) -> OllamaStatus {
        let url = format!("{}/api/tags", self.base_url);
        match self
            .client
            .get(&url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
        {
            Ok(resp) => {
                if resp.status().is_success() {
                    match resp.json::<TagsResponse>().await {
                        Ok(tags) => OllamaStatus {
                            connected: true,
                            models: tags.models.into_iter().map(|m| m.name).collect(),
                            error: None,
                        },
                        Err(e) => OllamaStatus {
                            connected: true,
                            models: vec![],
                            error: Some(format!("Failed to parse response: {}", e)),
                        },
                    }
                } else {
                    OllamaStatus {
                        connected: false,
                        models: vec![],
                        error: Some(format!("HTTP {}", resp.status())),
                    }
                }
            }
            Err(e) => {
                let msg = if e.is_connect() {
                    "OLLAMA_NOT_RUNNING".to_string()
                } else if e.is_timeout() {
                    "OLLAMA_TIMEOUT".to_string()
                } else {
                    e.to_string()
                };
                OllamaStatus {
                    connected: false,
                    models: vec![],
                    error: Some(msg),
                }
            }
        }
    }

    /// Generate text with streaming, calling the callback for each chunk
    pub async fn generate_stream<F>(
        &self,
        model: &str,
        prompt: &str,
        mut on_chunk: F,
    ) -> Result<String, String>
    where
        F: FnMut(&str, bool),
    {
        let url = format!("{}/api/generate", self.base_url);
        let body = GenerateRequest {
            model: model.to_string(),
            prompt: prompt.to_string(),
            stream: true,
        };

        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() {
                    "OLLAMA_NOT_RUNNING".to_string()
                } else if e.is_timeout() {
                    "OLLAMA_TIMEOUT".to_string()
                } else {
                    format!("Failed to connect to Ollama: {}", e)
                }
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Ollama returned HTTP {}: {}", status, text));
        }

        let mut full_response = String::new();
        let mut bytes_buf = Vec::new();

        // Read NDJSON stream chunk by chunk
        let mut stream = resp;
        while let Some(chunk) = stream
            .chunk()
            .await
            .map_err(|e| format!("Stream error: {}", e))?
        {
            bytes_buf.extend_from_slice(&chunk);

            while let Some(newline_pos) = bytes_buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = bytes_buf.drain(..=newline_pos).collect();
                let line_str = String::from_utf8_lossy(&line);
                let trimmed = line_str.trim();
                if trimmed.is_empty() {
                    continue;
                }

                if let Ok(parsed) = serde_json::from_str::<GenerateChunk>(trimmed) {
                    let text = parsed.response.unwrap_or_default();
                    let done = parsed.done.unwrap_or(false);
                    if !text.is_empty() {
                        full_response.push_str(&text);
                    }
                    on_chunk(&text, done);
                    if done {
                        return Ok(full_response);
                    }
                }
            }
        }

        if !bytes_buf.is_empty() {
            let line_str = String::from_utf8_lossy(&bytes_buf);
            let trimmed = line_str.trim();
            if !trimmed.is_empty() {
                if let Ok(parsed) = serde_json::from_str::<GenerateChunk>(trimmed) {
                    let text = parsed.response.unwrap_or_default();
                    if !text.is_empty() {
                        full_response.push_str(&text);
                    }
                    on_chunk(&text, true);
                }
            }
        }

        Ok(full_response)
    }
}
