pub mod client;
pub mod store;
#[cfg(test)]
pub(crate) mod test_server;

pub use client::{connect, Pop3Client, Pop3Session, MAX_MESSAGE_BYTES};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pop3Security {
    Ssl,
    StartTls,
}

impl std::str::FromStr for Pop3Security {
    type Err = Pop3Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "ssl" => Ok(Self::Ssl),
            "starttls" => Ok(Self::StartTls),
            other => Err(Pop3Error::Protocol(format!(
                "unknown security mode: {other}"
            ))),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Pop3Error {
    #[error("connection error: {0}")]
    Io(String),
    #[error("the server did not respond in time")]
    Timeout,
    #[error("TLS error: {0}")]
    Tls(String),
    #[error("authentication failed: {0}")]
    Auth(String),
    #[error("unexpected server response: {0}")]
    Protocol(String),
    #[error("the server does not support UIDL")]
    NoUidl,
    #[error("the mailbox is locked: {0}")]
    Locked(String),
    #[error("the message is too large ({0} bytes)")]
    TooLarge(u64),
}
