use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::task::JoinHandle;

pub(crate) fn scripted(
    script: Vec<(&'static str, &'static str)>,
) -> (DuplexStream, JoinHandle<()>) {
    let (client, server) = tokio::io::duplex(64 * 1024);
    let handle = tokio::spawn(async move {
        let mut server = BufReader::new(server);
        for (expected, mut reply) in script {
            if !expected.is_empty() {
                let mut line = String::new();
                server.read_line(&mut line).await.expect("read client line");
                assert_eq!(line, format!("{expected}\r\n"), "unexpected client line");
            }
            if let Some(rest) = reply.strip_prefix("<BUSY>") {
                crate::commands::backup::TEST_BUSY.set(true);
                reply = rest;
            }
            if reply == "<DROP>" {
                return;
            }
            if server.get_mut().write_all(reply.as_bytes()).await.is_err() {
                return;
            }
        }
        let mut extra = String::new();
        let _ = server.read_line(&mut extra).await;
        assert_eq!(extra, "", "client sent a line after the script ended");
    });
    (client, handle)
}
