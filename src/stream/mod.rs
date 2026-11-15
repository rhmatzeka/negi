//! The Mac's screen as live video, and its pointer and keys, without screen sharing:
//! ScreenCaptureKit for the picture, the hardware H.264 encoder, CGEvent for input.

pub mod capture;
pub mod encode;
pub mod input;
pub mod login;
