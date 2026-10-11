//! Dependency-light local server and browser owner. No artwork state on disk.
//!
//! The loop is deliberately shaped as three small steps — supervise the child,
//! answer one request, sleep — because a supervisor that is hard to read is a
//! supervisor nobody will trust at 2am. Everything it decides lives in
//! `roomd::lib`, where it is tested without a browser, a socket or a clock.
use roomd::{Progress, Recovery, Watchdog, http};
use std::{
    collections::VecDeque,
    fs,
    io::{self, Read},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

/// Health events retained. Bounded because this process outlives the exhibition
/// day, and an unbounded log is the classic way a supervisor outlives its
/// machine's memory.
const LOG_ENTRIES: usize = 64;

/// Largest asset the local server will read into memory and serve.
const MAX_ASSET_BYTES: u64 = 32 * 1024 * 1024;

struct Browser(Option<Child>);
impl Drop for Browser {
    fn drop(&mut self) {
        self.stop();
    }
}
impl Browser {
    fn stop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn now(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// What the operator asked for on the command line.
struct Options {
    root: PathBuf,
    browser_bin: Option<String>,
    port: u16,
    profile: PathBuf,
}

fn parse_args() -> Result<Option<Options>, Box<dyn std::error::Error>> {
    let mut options = Options {
        root: PathBuf::from("dist/client"),
        browser_bin: None,
        port: 7341,
        profile: PathBuf::from(".runtime/roomd-profile"),
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => options.root = args.next().ok_or("--root requires a path")?.into(),
            "--browser" => {
                options.browser_bin = Some(args.next().ok_or("--browser requires an executable")?);
            }
            "--profile" => {
                options.profile = args.next().ok_or("--profile requires a directory")?.into();
            }
            "--port" => options.port = args.next().ok_or("--port requires a number")?.parse()?,
            "--help" => {
                println!(
                    "roomd [--root dist/client] [--port 7341] [--browser /path/to/chrome] [--profile .runtime/roomd-profile]"
                );
                return Ok(None);
            }
            _ => return Err(format!("unknown argument: {arg}").into()),
        }
    }
    if options.port < 1024 {
        return Err("use a port between 1024 and 65535".into());
    }
    options.root = fs::canonicalize(options.root)?;
    if !options.root.join("index.html").is_file() {
        return Err("build the installation before starting roomd".into());
    }
    if options.browser_bin.is_some() {
        fs::create_dir_all(&options.profile)?;
        options.profile = fs::canonicalize(options.profile)?;
    }
    Ok(Some(options))
}

/// Everything the supervisor knows about the run it is supervising.
struct Session {
    start: Instant,
    watch: Watchdog,
    recovery: Recovery,
    browser: Browser,
    logs: VecDeque<serde_json::Value>,
    last_beat: Option<Progress>,
    received: Option<u64>,
}

impl Session {
    fn new(start: Instant) -> Self {
        Self {
            start,
            watch: Watchdog::new(0),
            recovery: Recovery::default(),
            browser: Browser(None),
            logs: VecDeque::with_capacity(LOG_ENTRIES),
            last_beat: None,
            received: None,
        }
    }

    fn note(&mut self, at_ms: u64, event: &str) {
        if self.logs.len() == LOG_ENTRIES {
            self.logs.pop_front();
        }
        self.logs
            .push_back(serde_json::json!({ "atMs": at_ms, "event": event }));
    }

    /// One pass of child-process supervision.
    ///
    /// Three failures, kept apart because they need different answers: the
    /// browser exited, the browser is running but no longer making progress,
    /// and the browser is not running and it is time to try again. Sensor loss
    /// is deliberately not one of them — see `Watchdog`.
    fn supervise(&mut self, binary: &str, port: u16, profile: &Path) -> io::Result<()> {
        let stamp = now(self.start);
        let exited = self
            .browser
            .0
            .as_mut()
            .map(Child::try_wait)
            .transpose()?
            .flatten()
            .is_some();
        let fault = if exited {
            Some("browser exited")
        } else if self.browser.0.is_some() {
            self.watch.failure(stamp)
        } else {
            None
        };
        if let Some(reason) = fault {
            self.browser.stop();
            self.recovery.failed(stamp);
            self.note(stamp, reason);
            eprintln!(
                "{reason}; {}",
                if self.recovery.faulted() {
                    "restart limit reached; inspect /health"
                } else {
                    "waiting before retry"
                }
            );
        } else if self.browser.0.is_some()
            && self.last_beat.is_some_and(|beat| beat.entered)
            && self.watch.failure(stamp).is_none()
        {
            self.recovery.healthy(stamp);
        }
        if self.browser.0.is_none() && self.recovery.ready(stamp) {
            self.launch(binary, port, profile, stamp);
        }
        Ok(())
    }

    fn launch(&mut self, binary: &str, port: u16, profile: &Path, stamp: u64) {
        let launched = Command::new(binary)
            .args([
                "--kiosk",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-session-crashed-bubble",
                "--hide-crash-restore-bubble",
                "--autoplay-policy=no-user-gesture-required",
            ])
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg(format!("http://127.0.0.1:{port}/"))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        if let Ok(child) = launched {
            self.browser.0 = Some(child);
            // A fresh browser has not reported anything yet, and last run's
            // counters are not evidence about this one.
            self.watch = Watchdog::new(stamp);
            self.last_beat = None;
            self.received = None;
        } else {
            self.recovery.failed(stamp);
            eprintln!("browser launch failed; check --browser executable");
        }
    }

    /// The operator-facing diagnostics, as aggregate numbers only.
    fn health(&self) -> io::Result<Vec<u8>> {
        let stamp = now(self.start);
        serde_json::to_vec(&serde_json::json!({
            "beat": self.last_beat,
            "ageMs": self.received.map(|at| stamp.saturating_sub(at)),
            "failure": self.watch.failure(stamp),
            "sensorStalled": self.watch.sensor_stalled(stamp),
            "faulted": self.recovery.faulted(),
            "events": self.logs,
        }))
        .map_err(io::Error::other)
    }

    fn answer(&mut self, stream: &mut TcpStream, root: &Path, port: u16) -> io::Result<()> {
        let request = http::read(stream, port)?;
        if request.path == "/supervisor/heartbeat" && request.method == "POST" {
            let beat: Progress = serde_json::from_slice(&request.body).map_err(io::Error::other)?;
            let stamp = now(self.start);
            self.watch.observe(beat, stamp);
            self.last_beat = Some(beat);
            self.received = Some(stamp);
            return http::respond(stream, "204 No Content", "text/plain", b"", false);
        }
        // The existing Node watchdog's heartbeat is independent; acknowledge it
        // without retaining arbitrary free text.
        if request.path == "/heartbeat" && request.method == "POST" {
            return http::respond(stream, "204 No Content", "text/plain", b"", false);
        }
        if !matches!(request.method.as_str(), "GET" | "HEAD") {
            return http::respond(
                stream,
                "405 Method Not Allowed",
                "text/plain",
                b"method not allowed",
                false,
            );
        }
        let head = request.method == "HEAD";
        if request.path == "/health" {
            let data = self.health()?;
            return http::respond(stream, "200 OK", "application/json", &data, head);
        }
        if self.recovery.faulted() {
            return http::respond(
                stream,
                "503 Service Unavailable",
                "text/html; charset=utf-8",
                b"<!doctype html><title>Room paused</title><h1>The room is paused</h1><p>The browser repeatedly failed. Check the display and browser installation, then restart roomd. <a href='/health'>Local diagnostics</a></p>",
                head,
            );
        }
        serve(stream, root, &request.path, head)
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let Some(options) = parse_args()? else {
        return Ok(());
    };
    let listener = TcpListener::bind(("127.0.0.1", options.port))?;
    listener.set_nonblocking(true)?;
    let running = Arc::new(AtomicBool::new(true));
    let signal = Arc::clone(&running);
    ctrlc::set_handler(move || signal.store(false, Ordering::Relaxed))?;
    let mut session = Session::new(Instant::now());
    println!("Room listening at http://127.0.0.1:{}/", options.port);
    while running.load(Ordering::Relaxed) {
        if let Some(binary) = &options.browser_bin {
            session.supervise(binary, options.port, &options.profile)?;
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                if session
                    .answer(&mut stream, &options.root, options.port)
                    .is_err()
                {
                    let _ = http::respond(
                        &mut stream,
                        "400 Bad Request",
                        "text/plain",
                        b"invalid request",
                        false,
                    );
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn serve(stream: &mut TcpStream, root: &Path, path: &str, head: bool) -> io::Result<()> {
    let Ok(file) = http::artifact(root, path) else {
        return http::respond(stream, "404 Not Found", "text/plain", b"not found", head);
    };
    let mut input = fs::File::open(&file)?.take(MAX_ASSET_BYTES + 1);
    let mut data = Vec::new();
    input.read_to_end(&mut data)?;
    if data.len() as u64 > MAX_ASSET_BYTES {
        return http::respond(
            stream,
            "413 Content Too Large",
            "text/plain",
            b"asset exceeds 32 MiB",
            head,
        );
    }
    http::respond(stream, "200 OK", http::mime(&file), &data, head)
}
