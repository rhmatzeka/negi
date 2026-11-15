//! One tmux control client: commands go in on its stdin, replies and notifications come
//! out on its stdout. Nothing here forks per command.

use std::collections::VecDeque;
use std::fmt;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};

use crate::tmux::Tmux;
use crate::tmux::proto::{self, Line, Notice};

/// A hung tmux must not hang a phone.
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    /// The control client exited, with whatever tmux printed on the way out.
    Closed(String),
    Timeout,
    /// tmux answered with `%error`.
    Tmux(String),
    /// The request was refused before anything reached tmux.
    Invalid(&'static str),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "{e}"),
            Self::Closed(why) if why.is_empty() => f.write_str("tmux closed the connection"),
            Self::Closed(why) => f.write_str(why),
            Self::Timeout => f.write_str("tmux did not answer"),
            Self::Tmux(msg) => f.write_str(msg),
            Self::Invalid(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for Error {}

impl Error {
    /// tmux's wording for a pane, window or session that no longer exists.
    pub fn is_gone(&self) -> bool {
        matches!(self, Self::Tmux(msg) if msg.starts_with("can't find"))
    }
}

type Reply = Result<Vec<u8>, String>;

struct Shared {
    /// One sender per command line written, in the order written.
    pending: Mutex<VecDeque<oneshot::Sender<Reply>>>,
    alive: AtomicBool,
    stderr: Mutex<String>,
}

pub struct Link {
    id: u64,
    shared: Arc<Shared>,
    stdin: tokio::sync::Mutex<ChildStdin>,
    // Killed on drop, which ends the reader task too.
    _child: Child,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

impl Link {
    /// Attaches a control client to `session`, or the most recent one, with `ignore-size` so it
    /// resizes no one's windows; notifications arrive on `notices`, tagged with [`Link::id`].
    pub fn attach(
        tmux: &Tmux,
        session: Option<&str>,
        notices: mpsc::UnboundedSender<(u64, Notice)>,
    ) -> Result<Self, Error> {
        let mut cmd = Command::new(tmux.bin());
        cmd.args(tmux.base_args()).args(["-C", "attach-session"]);
        if let Some(session) = session {
            cmd.args(["-t", session]);
        }
        cmd.args(["-f", "ignore-size"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(Error::Io)?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let mut stderr = child.stderr.take().expect("stderr is piped");
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let shared = Arc::new(Shared {
            pending: Mutex::new(VecDeque::new()),
            alive: AtomicBool::new(true),
            stderr: Mutex::new(String::new()),
        });
        let errors = shared.clone();
        tokio::spawn(async move {
            let mut text = String::new();
            let _ = (&mut stderr).take(4096).read_to_string(&mut text).await;
            *errors.stderr.lock().unwrap() = text.trim().to_owned();
        });
        tokio::spawn(read(stdout, shared.clone(), id, notices));
        Ok(Self {
            id,
            shared,
            stdin: tokio::sync::Mutex::new(stdin),
            _child: child,
        })
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn alive(&self) -> bool {
        self.shared.alive.load(Ordering::Relaxed)
    }

    /// Runs one command and returns what it printed.
    pub async fn run(&self, line: String) -> Result<Vec<u8>, Error> {
        let mut replies = self.batch(vec![line]).await?;
        replies.pop().expect("one reply per line")
    }

    /// Writes the lines in one go, so no other caller's command lands between them, and
    /// returns one result per line. Each line must hold exactly one command: tmux stops a
    /// `;` sequence at its first error, which would leave fewer replies than commands.
    pub async fn batch(&self, lines: Vec<String>) -> Result<Vec<Result<Vec<u8>, Error>>, Error> {
        let mut waiting = Vec::with_capacity(lines.len());
        {
            let mut stdin = self.stdin.lock().await;
            if !self.alive() {
                return Err(self.closed());
            }
            let mut wire = Vec::new();
            {
                let mut pending = self.shared.pending.lock().unwrap();
                for line in &lines {
                    debug_assert!(!line.contains('\n'), "one command per line");
                    let (tx, rx) = oneshot::channel();
                    pending.push_back(tx);
                    waiting.push(rx);
                    wire.extend_from_slice(line.as_bytes());
                    wire.push(b'\n');
                }
            }
            let written = async {
                stdin.write_all(&wire).await?;
                stdin.flush().await
            };
            if written.await.is_err() {
                self.shared.alive.store(false, Ordering::Relaxed);
                return Err(self.closed());
            }
        }
        let collect = async {
            let mut out = Vec::with_capacity(waiting.len());
            for rx in waiting {
                out.push(match rx.await {
                    Ok(Ok(body)) => Ok(body),
                    Ok(Err(msg)) => Err(Error::Tmux(msg)),
                    Err(_) => return Err(self.closed()),
                });
            }
            Ok(out)
        };
        match tokio::time::timeout(REPLY_TIMEOUT, collect).await {
            Ok(result) => result,
            Err(_) => Err(Error::Timeout),
        }
    }

    fn closed(&self) -> Error {
        Error::Closed(self.shared.stderr.lock().unwrap().clone())
    }
}

async fn read(
    stdout: ChildStdout,
    shared: Arc<Shared>,
    id: u64,
    notices: mpsc::UnboundedSender<(u64, Notice)>,
) {
    let mut reader = BufReader::new(stdout);
    // Bytes, not `lines()`: panes may print anything, valid UTF-8 or not.
    let mut line = Vec::new();
    let mut block: Option<Block> = None;
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if let Some(open) = &mut block {
            match proto::closes(&line, &open.tag) {
                Some(ok) => {
                    let done = block.take().expect("a block is open");
                    if done.ours {
                        let reply = if ok {
                            Ok(done.body)
                        } else {
                            Err(String::from_utf8_lossy(&done.body).trim().to_owned())
                        };
                        let waiter = shared.pending.lock().unwrap().pop_front();
                        if let Some(waiter) = waiter {
                            let _ = waiter.send(reply);
                        }
                    }
                }
                None => {
                    open.body.extend_from_slice(&line);
                    open.body.push(b'\n');
                }
            }
            continue;
        }
        match proto::parse(&line) {
            Line::Begin { tag, ours } => {
                block = Some(Block {
                    tag: tag.to_vec(),
                    ours,
                    body: Vec::new(),
                });
            }
            Line::Notice(notice) => {
                // Dead before anyone hears of the exit, or a listener would reuse the link.
                if notice == Notice::Exit {
                    shared.alive.store(false, Ordering::Relaxed);
                }
                let _ = notices.send((id, notice));
            }
            _ => {}
        }
    }
    shared.alive.store(false, Ordering::Relaxed);
    // Dropping the senders wakes every caller still waiting.
    shared.pending.lock().unwrap().clear();
    let _ = notices.send((id, Notice::Exit));
}

struct Block {
    tag: Vec<u8>,
    ours: bool,
    body: Vec<u8>,
}
