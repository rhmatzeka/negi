//! tmux as negi uses it. Here: invoking tmux and quoting its syntax. `proto` reads control
//! mode, `link` holds a client, `mux` sends commands, `screen` diffs captures into rows.

pub mod link;
pub mod mux;
pub mod proto;
pub mod screen;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Which tmux server to talk to: `-L name`, `-S path`, or tmux's default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Socket {
    #[default]
    Default,
    Name(String),
    Path(PathBuf),
}

#[derive(Debug, Clone)]
pub struct Tmux {
    bin: PathBuf,
    socket: Socket,
}

impl Tmux {
    /// A service started by launchd has no login PATH, so the usual install locations are
    /// tried before PATH. `NEGI_TMUX` overrides all of it.
    pub fn find(socket: Socket) -> Result<Self, String> {
        if let Some(bin) = std::env::var_os("NEGI_TMUX") {
            return Ok(Self {
                bin: bin.into(),
                socket,
            });
        }
        let fixed = [
            "/opt/homebrew/bin/tmux",
            "/usr/local/bin/tmux",
            "/usr/bin/tmux",
        ];
        let on_path = std::env::var_os("PATH")
            .map(|p| {
                std::env::split_paths(&p)
                    .map(|d| d.join("tmux"))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        fixed
            .iter()
            .map(PathBuf::from)
            .chain(on_path)
            .find(|p| p.is_file())
            .map(|bin| Self { bin, socket })
            .ok_or_else(|| "tmux not found; set NEGI_TMUX to its path".to_owned())
    }

    pub fn with(bin: impl Into<PathBuf>, socket: Socket) -> Self {
        Self {
            bin: bin.into(),
            socket,
        }
    }

    pub fn bin(&self) -> &Path {
        &self.bin
    }

    pub fn socket(&self) -> &Socket {
        &self.socket
    }

    /// Arguments every invocation starts with. `-u` matters: without it a client started
    /// in a non-UTF-8 locale gets every non-ASCII character replaced by `_`.
    pub fn base_args(&self) -> Vec<OsString> {
        let mut args: Vec<OsString> = vec!["-u".into()];
        match &self.socket {
            Socket::Default => {}
            Socket::Name(name) => args.extend(["-L".into(), name.into()]),
            Socket::Path(path) => args.extend(["-S".into(), path.into()]),
        }
        args
    }

    /// A plain, forking tmux command. Only for what a control client cannot do: starting
    /// a server that is not running.
    pub fn command(&self) -> Command {
        let mut c = Command::new(&self.bin);
        c.args(self.base_args());
        c
    }
}

/// Quotes one argument for a command line written to a control client. Refuses control
/// characters: a newline would end the command and start another.
pub fn quote(arg: &str) -> Option<String> {
    if arg.chars().any(char::is_control) {
        return None;
    }
    Some(format!("'{}'", arg.replace('\'', "'\\''")))
}

/// `%12`, `@3` or `$0`: tmux's own ids, unique for the server's lifetime. Nothing else is
/// accepted as a target, so no client can send target syntax such as `work:1.2` or `{last}`.
pub fn is_id(sigil: char, s: &str) -> bool {
    let mut chars = s.chars();
    chars.next() == Some(sigil) && s.len() > 1 && s.len() <= 12 && chars.all(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_survives_every_shell_like_character() {
        assert_eq!(quote("plain").unwrap(), "'plain'");
        assert_eq!(quote("it's").unwrap(), "'it'\\''s'");
        assert_eq!(
            quote("a; b #{x} $HOME ~ \"q\" \\").unwrap(),
            "'a; b #{x} $HOME ~ \"q\" \\'"
        );
        assert_eq!(quote("").unwrap(), "''");
    }

    #[test]
    fn quoting_refuses_control_characters() {
        assert_eq!(quote("a\nkill-server"), None);
        assert_eq!(quote("a\rb"), None);
        assert_eq!(quote("tab\there"), None);
        assert_eq!(quote("esc\u{1b}"), None);
    }

    #[test]
    fn ids_are_a_sigil_and_digits() {
        assert!(is_id('%', "%0"));
        assert!(is_id('@', "@123"));
        assert!(is_id('$', "$7"));
        for bad in [
            "%", "0", "%1a", "%-1", "@1", "work:1.2", "{last}", "% 1", "%1 ", "",
        ] {
            assert!(!is_id('%', bad), "{bad:?}");
        }
        assert!(!is_id('%', "%123456789012"));
    }

    #[test]
    fn the_socket_becomes_arguments() {
        let t = Tmux::with("/x/tmux", Socket::Name("other".into()));
        assert_eq!(t.base_args(), ["-u", "-L", "other"].map(OsString::from));
        let t = Tmux::with("/x/tmux", Socket::Default);
        assert_eq!(t.base_args(), ["-u"].map(OsString::from));
    }
}
