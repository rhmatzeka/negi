//! negi: tmux on a phone, over one control-mode connection per session.

pub mod awake;
pub mod hub;
pub mod server;
pub mod store;
#[cfg(target_os = "macos")]
pub mod stream;
pub mod tmux;
pub mod tailnet;
