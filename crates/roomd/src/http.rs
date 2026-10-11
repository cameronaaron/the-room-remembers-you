//! Bounded HTTP parsing and canonical artifact paths; no request logging.
use std::{
    fs,
    io::{self, Read, Write},
    net::TcpStream,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub body: Vec<u8>,
}

pub fn read(stream: &mut TcpStream, port: u16) -> io::Result<Request> {
    let start = Instant::now();
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        let left = Duration::from_millis(500)
            .checked_sub(start.elapsed())
            .ok_or_else(|| io::Error::other("request timeout"))?;
        stream.set_read_timeout(Some(left.max(Duration::from_millis(1))))?;
        if headers.len() >= 8192 {
            return Err(io::Error::other("headers too large"));
        }
        let mut byte = [0];
        stream.read_exact(&mut byte)?;
        headers.push(byte[0]);
    }
    let text = std::str::from_utf8(&headers).map_err(io::Error::other)?;
    let mut lines = text.split("\r\n");
    let mut parts = lines.next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("").to_owned();
    let path = parts.next().unwrap_or("").to_owned();
    if parts.next() != Some("HTTP/1.1") || parts.next().is_some() || !path.starts_with('/') {
        return Err(io::Error::other("invalid request line"));
    }
    let mut length = None;
    let mut host = None;
    let expected = format!("127.0.0.1:{port}");
    for line in lines.filter(|s| !s.is_empty()) {
        let (key, value) = line
            .split_once(':')
            .ok_or_else(|| io::Error::other("invalid header"))?;
        let value = value.trim();
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                if host.replace(value).is_some() {
                    return Err(io::Error::other("duplicate host"));
                }
            }
            "origin" => {
                if value != format!("http://{expected}") {
                    return Err(io::Error::other("foreign origin"));
                }
            }
            "content-length" => {
                if length.is_some() {
                    return Err(io::Error::other("duplicate length"));
                }
                length = Some(value.parse::<usize>().map_err(io::Error::other)?);
            }
            "transfer-encoding" => return Err(io::Error::other("transfer encoding unsupported")),
            _ => {}
        }
    }
    if host != Some(expected.as_str()) {
        return Err(io::Error::other("foreign host"));
    }
    let length = length.unwrap_or(0);
    if length > 4096 {
        return Err(io::Error::other("body too large"));
    }
    let mut body = vec![0; length];
    let left = Duration::from_millis(500)
        .checked_sub(start.elapsed())
        .ok_or_else(|| io::Error::other("request timeout"))?;
    stream.set_read_timeout(Some(left.max(Duration::from_millis(1))))?;
    stream.read_exact(&mut body)?;
    Ok(Request { method, path, body })
}

pub fn artifact(root: &Path, url: &str) -> io::Result<PathBuf> {
    let url = url.split('?').next().unwrap_or(url);
    let mut decoded = Vec::new();
    let mut bytes = url.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let hi = bytes.next().and_then(|v| char::from(v).to_digit(16));
            let lo = bytes.next().and_then(|v| char::from(v).to_digit(16));
            let value = hi
                .zip(lo)
                .map(|(a, b)| a * 16 + b)
                .ok_or_else(|| io::Error::other("bad escape"))?;
            decoded.push(u8::try_from(value).map_err(io::Error::other)?);
        } else {
            decoded.push(b);
        }
    }
    let decoded = String::from_utf8(decoded).map_err(io::Error::other)?;
    if decoded.contains(['\\', '\0']) {
        return Err(io::Error::other("invalid path"));
    }
    let relative = Path::new(decoded.trim_start_matches('/'));
    if relative
        .components()
        .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err(io::Error::other("invalid component"));
    }
    let mut target = root.join(relative);
    if target.is_dir() {
        target = target.join("index.html");
    }
    let target = fs::canonicalize(target)?;
    if !target.starts_with(root) || !target.is_file() {
        return Err(io::Error::other("outside artifact root"));
    }
    Ok(target)
}

#[must_use]
pub fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|s| s.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "wav" => "audio/wav",
        "png" => "image/png",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}
pub fn respond(
    stream: &mut TcpStream,
    status: &str,
    mime: &str,
    body: &[u8],
    head: bool,
) -> io::Result<()> {
    stream.set_write_timeout(Some(Duration::from_millis(500)))?;
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nPermissions-Policy: camera=(self), microphone=(self)\r\n\r\n",
        body.len()
    )?;
    if !head {
        stream.write_all(body)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal_malformed_paths_and_escaped_separators() {
        let root = fs::canonicalize(env!("CARGO_MANIFEST_DIR")).unwrap();
        for path in [
            "/../Cargo.toml",
            "/%2e%2e/Cargo.toml",
            "/%2e%2e%2fCargo.toml",
            "/%xx",
            "/%00",
            "/..\\Cargo.toml",
        ] {
            assert!(artifact(&root, path).is_err(), "{path}");
        }
        assert_eq!(
            artifact(&root, "/Cargo.toml?v=1").unwrap(),
            root.join("Cargo.toml")
        );
        assert_eq!(mime(Path::new("a.wasm")), "application/wasm");
    }
}
