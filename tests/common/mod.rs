//! A scratch tmux server per test: its own socket and no config file, so the tests never
//! see the developer's sessions, tmux.conf or plugins.

#![allow(dead_code)]

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use negi::tmux::link::Link;
use negi::tmux::mux;
use negi::tmux::{Socket, Tmux};

static NEXT: AtomicU32 = AtomicU32::new(0);

pub struct Scratch {
    pub tmux: Tmux,
    socket: PathBuf,
}

impl Scratch {
    pub fn new() -> Self {
        // A socket of the test's own, removed afterwards: tmux leaves the file behind.
        let name = format!(
            "negi-test-{}-{}.sock",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let socket = std::env::temp_dir().join(name);
        let found = Tmux::find(Socket::Default).expect("the live tests need tmux");
        let tmux = Tmux::with(found.bin(), Socket::Path(socket.clone()));
        Self { tmux, socket }
    }

    /// Runs a plain tmux command against the scratch server.
    pub fn run(&self, args: &[&str]) -> String {
        let out = Command::new(self.tmux.bin())
            .arg("-u")
            .arg("-S")
            .arg(&self.socket)
            .args(["-f", "/dev/null"])
            .args(args)
            .output()
            .expect("tmux runs");
        assert!(
            out.status.success(),
            "tmux {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    /// A detached session running `program`, 80 by 24. Returns its first pane id.
    pub fn session(&self, name: &str, program: &str) -> String {
        self.run(&[
            "new-session",
            "-d",
            "-P",
            "-F",
            "#{pane_id}",
            "-s",
            name,
            "-x",
            "80",
            "-y",
            "24",
            program,
        ])
    }

    pub async fn link(&self) -> Link {
        mux::open(&self.tmux)
            .await
            .expect("a control client attaches")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = Command::new(self.tmux.bin())
            .arg("-S")
            .arg(&self.socket)
            .arg("kill-server")
            .output();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Polls the pane until its screen contains `needle`.
pub async fn screen_with(link: &Link, pane: &str, needle: &str) -> mux::Screen {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let screen = mux::screen(link, pane).await.expect("the pane exists");
        if screen.lines.iter().any(|l| l.contains(needle)) {
            return screen;
        }
        assert!(
            Instant::now() < deadline,
            "no {needle:?} on screen:\n{}",
            screen.lines.join("\n")
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}
