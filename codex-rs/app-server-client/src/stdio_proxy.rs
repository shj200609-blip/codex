//! Transparent JSONL/WebSocket transport for stdio-only IDE clients.
//! The IDE owns initialize and approval interaction. This proxy never starts Core,
//! interprets protocol messages, or shuts down the shared server.

use std::io;

use crate::RemoteAppServerEndpoint;
use crate::remote::REMOTE_APP_SERVER_MAX_WEBSOCKET_MESSAGE_SIZE;
use crate::remote::SocketPeerPolicy;
use crate::remote::connect_unix_socket_endpoint;
use crate::remote::connect_websocket_endpoint;
use futures::SinkExt;
use futures::StreamExt;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::codec::FramedRead;
use tokio_util::codec::LinesCodec;

pub async fn run_stdio_proxy(endpoint: RemoteAppServerEndpoint) -> io::Result<()> {
    match endpoint {
        RemoteAppServerEndpoint::WebSocket {
            websocket_url,
            auth_token,
        } => {
            let (_, stream) = connect_websocket_endpoint(websocket_url, auth_token)
                .await
                .map_err(connection_error)?;
            relay(stream, tokio::io::stdin(), tokio::io::stdout()).await
        }
        RemoteAppServerEndpoint::UnixSocket { socket_path } => {
            let (_, stream) =
                connect_unix_socket_endpoint(socket_path, SocketPeerPolicy::ExplicitEndpoint)
                    .await
                    .map_err(connection_error)?;
            relay(stream, tokio::io::stdin(), tokio::io::stdout()).await
        }
    }
}

fn connection_error(err: io::Error) -> io::Error {
    io::Error::new(
        err.kind(),
        format!("Unable to connect to shared Codex server: {err}"),
    )
}

async fn relay<S, R, W>(stream: WebSocketStream<S>, input: R, mut output: W) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let (mut sender, mut receiver) = stream.split();
    let mut lines = FramedRead::new(
        input,
        LinesCodec::new_with_max_length(REMOTE_APP_SERVER_MAX_WEBSOCKET_MESSAGE_SIZE),
    );
    loop {
        tokio::select! {
            line = lines.next() => {
                match line {
                    Some(Ok(line)) if line.trim().is_empty() => {}
                    Some(Ok(line)) => sender.send(Message::Text(line.into())).await.map_err(io::Error::other)?,
                    Some(Err(err)) => return Err(io::Error::new(io::ErrorKind::InvalidData, err)),
                    None => {
                        // Close only this IDE connection. There is no server shutdown RPC.
                        sender.close().await.map_err(io::Error::other)?;
                        return Ok(());
                    }
                }
            }
            message = receiver.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        output.write_all(text.as_bytes()).await?;
                        output.write_all(b"\n").await?;
                        output.flush().await?;
                    }
                    Some(Ok(Message::Ping(_))) => sender.flush().await.map_err(io::Error::other)?,
                    Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
                    Some(Ok(Message::Binary(_))) => return Err(io::Error::new(io::ErrorKind::InvalidData, "Shared Codex server sent a binary JSON-RPC frame")),
                    Some(Ok(Message::Close(_))) | None => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "Shared Codex server disconnected")),
                    Some(Err(err)) => return Err(io::Error::other(format!("Shared Codex server transport failed: {err}"))),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;
    use tokio::io::BufReader;
    use tokio::net::TcpListener;
    use tokio::net::TcpStream;
    use tokio::time::Duration;
    use tokio::time::timeout;
    use tokio_tungstenite::accept_async;
    use tokio_tungstenite::connect_async;

    #[tokio::test]
    async fn preserves_initialize_unknown_fields_approval_ids_and_notifications() {
        let listener = std::sync::Arc::new(TcpListener::bind("127.0.0.1:0").await.unwrap());
        let addr = listener.local_addr().unwrap();
        let peer_listener = listener.clone();
        let peer = tokio::spawn(async move {
            let (socket, _) = peer_listener.accept().await.unwrap();
            accept_async(socket).await.unwrap()
        });
        let (client, _) = connect_async(format!("ws://{addr}")).await.unwrap();
        let mut server = peer.await.unwrap();
        let (mut input, proxy_input) = tokio::io::duplex(4096);
        let (proxy_output, output) = tokio::io::duplex(4096);
        let mut output = BufReader::new(output);
        let proxy = tokio::spawn(relay(client, proxy_input, proxy_output));
        let initialize =
            r#"{"id":"ide-1","method":"initialize","params":{"futureCapability":true}}"#;
        // Fragmentation and CRLF must not change the JSON message or IDs.
        input.write_all(&initialize.as_bytes()[..13]).await.unwrap();
        input.write_all(&initialize.as_bytes()[13..]).await.unwrap();
        input.write_all(b"\r\n").await.unwrap();
        assert_eq!(
            server.next().await.unwrap().unwrap().into_text().unwrap(),
            initialize
        );
        for message in [
            r#"{"id":"approval-7","method":"item/commandExecution/requestApproval","params":{"threadId":"a"}}"#,
            r#"{"method":"changeSet/updated","params":{"revision":2}}"#,
        ] {
            server.send(Message::Text(message.into())).await.unwrap();
            let mut line = String::new();
            output.read_line(&mut line).await.unwrap();
            assert_eq!(line, format!("{message}\n"));
        }
        let approval = r#"{"id":"approval-7","result":{"decision":"accept"}}"#;
        input
            .write_all(format!("{approval}\n").as_bytes())
            .await
            .unwrap();
        assert_eq!(
            server.next().await.unwrap().unwrap().into_text().unwrap(),
            approval
        );
        drop(input);
        assert!(
            timeout(Duration::from_secs(2), proxy)
                .await
                .unwrap()
                .unwrap()
                .is_ok()
        );
        assert!(matches!(
            server.next().await.unwrap().unwrap(),
            Message::Close(_)
        ));
        // Only a connection closed; the listener still accepts another producer.
        let connection = TcpStream::connect(addr).await.unwrap();
        let _ = listener.accept().await.unwrap();
        drop(connection);
    }

    #[tokio::test]
    async fn server_disconnect_is_reported_instead_of_local_fallback() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            accept_async(socket).await.unwrap()
        });
        let (client, _) = connect_async(format!("ws://{addr}")).await.unwrap();
        let mut server = peer.await.unwrap();
        let (_input, proxy_input) = tokio::io::duplex(64);
        let (proxy_output, _output) = tokio::io::duplex(64);
        let proxy = tokio::spawn(relay(client, proxy_input, proxy_output));
        server.close(None).await.unwrap();
        let err = timeout(Duration::from_secs(2), proxy)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
        assert!(err.to_string().contains("Shared Codex server disconnected"));
    }
}
