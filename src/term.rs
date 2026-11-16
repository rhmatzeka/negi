//! The terminal side of the interactive commands: a spinner, unechoed keys, the clipboard.

use std::sync::Arc;
use std::time::Duration;

use console::style;

/// A one-line spinner that ends on a real line break; cliclack's pads to the terminal width.
pub struct Spinner {
    state: Arc<std::sync::Mutex<(String, bool)>>,
    ticker: std::cell::RefCell<Option<std::thread::JoinHandle<()>>>,
}

impl Spinner {
    pub fn new() -> Self {
        Self { state: Arc::new(std::sync::Mutex::new((String::new(), false))), ticker: None.into() }
    }

    pub fn start(&self, message: impl std::fmt::Display) {
        *self.state.lock().unwrap() = (message.to_string(), true);
        let state = self.state.clone();
        *self.ticker.borrow_mut() = Some(std::thread::spawn(move || {
            for frame in ["◒", "◐", "◓", "◑"].into_iter().cycle() {
                {
                    let s = state.lock().unwrap();
                    if !s.1 {
                        return;
                    }
                    // A wrapped line cannot be redrawn with \r.
                    let width = usize::from(console::Term::stderr().size().1).saturating_sub(4).max(1);
                    eprint!("\r\x1b[2K{}  {}", style(frame).magenta(), console::truncate_str(&s.0, width, "…"));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }));
    }

    pub fn set_message(&self, message: impl std::fmt::Display) {
        self.state.lock().unwrap().0 = message.to_string();
    }

    fn end(&self, symbol: console::StyledObject<&str>, message: impl std::fmt::Display) {
        self.state.lock().unwrap().1 = false;
        if let Some(t) = self.ticker.borrow_mut().take() {
            let _ = t.join();
        }
        eprint!("\r\x1b[2K{symbol}  {message}\n{}\n", style("│").color256(8));
    }

    /// Prints a line above the spinner, which keeps turning.
    pub fn say(&self, message: impl std::fmt::Display) {
        let _held = self.state.lock().unwrap();
        eprint!("\r\x1b[2K{}  {message}\n{}\n", style("◆").green(), style("│").color256(8));
    }

    pub fn stop(&self, message: impl std::fmt::Display) {
        self.end(style("◇").green(), message);
    }

    pub fn error(&self, message: impl std::fmt::Display) {
        self.end(style("▲").red(), message);
    }

    pub fn cancel(&self, message: impl std::fmt::Display) {
        self.end(style("■").red(), message);
    }
}

/// Turns off echo and line buffering until dropped, so single keys can be polled.
pub struct Quiet(libc::termios);

impl Quiet {
    pub fn new() -> Option<Self> {
        let mut was = unsafe { std::mem::zeroed::<libc::termios>() };
        // SAFETY: plain termios calls on stdin with a struct of the right type.
        unsafe {
            if libc::tcgetattr(libc::STDIN_FILENO, &mut was) != 0 {
                return None;
            }
            let mut quiet = was;
            quiet.c_lflag &= !(libc::ECHO | libc::ECHOCTL | libc::ICANON);
            quiet.c_cc[libc::VMIN] = 0;
            quiet.c_cc[libc::VTIME] = 0;
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &quiet);
        }
        Some(Self(was))
    }
}

impl Drop for Quiet {
    fn drop(&mut self) {
        // SAFETY: restores the settings read in `new`.
        unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.0) };
    }
}

/// A key pressed since the last call. Blocks unless `Quiet` is in place.
pub fn key() -> Option<u8> {
    let mut b = 0u8;
    // SAFETY: reads at most one byte into a local.
    (unsafe { libc::read(libc::STDIN_FILENO, (&raw mut b).cast(), 1) } == 1).then_some(b)
}

/// Puts `text` on the clipboard of the terminal in front of the person: pbcopy on this Mac,
/// otherwise OSC 52, which the terminal at the other end of SSH (or around tmux) carries out.
pub fn copy(text: &str) -> bool {
    use std::io::Write;
    let piped = |program: &str, args: &[&str]| {
        let Ok(mut child) = std::process::Command::new(program).args(args).stdin(std::process::Stdio::piped()).spawn() else {
            return false;
        };
        let wrote = child.stdin.take().is_some_and(|mut i| i.write_all(text.as_bytes()).is_ok());
        child.wait().is_ok_and(|s| s.success()) && wrote
    };
    let remote = std::env::var_os("SSH_CONNECTION").is_some() || std::env::var_os("SSH_TTY").is_some();
    if cfg!(target_os = "macos") && !remote && piped("/usr/bin/pbcopy", &[]) {
        return true;
    }
    // tmux keeps an application's OSC 52 to itself unless set-clipboard is on; -w hands it on.
    if std::env::var_os("TMUX").is_some() && piped("tmux", &["load-buffer", "-w", "-"]) {
        return true;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/tty")
        .and_then(|mut tty| tty.write_all(format!("\x1b]52;c;{}\x07", base64(text.as_bytes())).as_bytes()))
        .is_ok()
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() { ABC[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64;

    #[test]
    fn base64_matches_the_standard() {
        for (plain, coded) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("2KUM-WUT2", "MktVTS1XVVQy")] {
            assert_eq!(base64(plain.as_bytes()), coded);
        }
    }
}
