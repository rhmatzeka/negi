//! Pointer and keys posted as the Mac's own devices, from what a VNC client sends (a button
//! mask, X11 keysyms), so the page drives either path the same. Needs Accessibility.

use std::ffi::c_void;
use std::time::{Duration, Instant};

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField, ScrollEventUnit};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;

use super::capture::Geometry;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

/// Whether this process may post input. The first time it may not, macOS offers to open
/// the setting; it never changes the setting itself.
pub fn allowed(ask: bool) -> bool {
    unsafe {
        let options = CFDictionary::from_CFType_pairs(&[(
            CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt).as_CFType(),
            CFBoolean::from(ask).as_CFType(),
        )]);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef().cast()) != 0
    }
}

const LEFT: u8 = 1;
const MIDDLE: u8 = 2;
const RIGHT: u8 = 4;
const WHEEL_UP: u8 = 8;
const WHEEL_DOWN: u8 = 16;
const WHEEL_LEFT: u8 = 32;
const WHEEL_RIGHT: u8 = 64;

/// How close in time and place two presses must be to count as one double click.
const DOUBLE: Duration = Duration::from_millis(450);
const NEAR: f64 = 6.0;

pub struct Input {
    geometry: Geometry,
    mask: u8,
    at: CGPoint,
    flags: CGEventFlags,
    last_press: Option<(Instant, CGPoint, u8)>,
    clicks: i64,
}

impl Input {
    pub fn new(geometry: Geometry) -> Self {
        let at = CGPoint::new(geometry.origin.0 + geometry.size.0 / 2.0, geometry.origin.1 + geometry.size.1 / 2.0);
        Self { geometry, mask: 0, at, flags: CGEventFlags::CGEventFlagNull, last_press: None, clicks: 0 }
    }

    /// The pointer at (`x`, `y`) in the video's pixels, with the buttons in `mask` down.
    pub fn pointer(&mut self, x: f64, y: f64, mask: u8) {
        let g = self.geometry;
        let fx = (x / g.width as f64).clamp(0.0, 1.0);
        let fy = (y / g.height as f64).clamp(0.0, 1.0);
        let to = CGPoint::new(g.origin.0 + fx * (g.size.0 - 1.0), g.origin.1 + fy * (g.size.1 - 1.0));
        let before = self.mask;
        if to.x != self.at.x || to.y != self.at.y {
            self.at = to;
            let (kind, button) = if before & LEFT != 0 {
                (CGEventType::LeftMouseDragged, CGMouseButton::Left)
            } else if before & RIGHT != 0 {
                (CGEventType::RightMouseDragged, CGMouseButton::Right)
            } else if before & MIDDLE != 0 {
                (CGEventType::OtherMouseDragged, CGMouseButton::Center)
            } else {
                (CGEventType::MouseMoved, CGMouseButton::Left)
            };
            self.mouse(kind, button, None);
        }
        for (bit, button, down, up) in [
            (LEFT, CGMouseButton::Left, CGEventType::LeftMouseDown, CGEventType::LeftMouseUp),
            (RIGHT, CGMouseButton::Right, CGEventType::RightMouseDown, CGEventType::RightMouseUp),
            (MIDDLE, CGMouseButton::Center, CGEventType::OtherMouseDown, CGEventType::OtherMouseUp),
        ] {
            let (was, is) = (before & bit != 0, mask & bit != 0);
            if !was && is {
                let now = Instant::now();
                let again = self.last_press.is_some_and(|(when, at, b)| {
                    b == bit && now - when < DOUBLE && (at.x - to.x).abs() < NEAR && (at.y - to.y).abs() < NEAR
                });
                self.clicks = if again { self.clicks + 1 } else { 1 };
                self.last_press = Some((now, to, bit));
                self.mouse(down, button, Some(self.clicks));
            } else if was && !is {
                self.mouse(up, button, Some(self.clicks));
            }
        }
        // A wheel "button" is pressed and let go for each step, as VNC does it.
        let pressed = mask & !before;
        let lines = |up: u8, down: u8| i32::from(pressed & up != 0) - i32::from(pressed & down != 0);
        let (vertical, horizontal) = (lines(WHEEL_UP, WHEEL_DOWN), lines(WHEEL_LEFT, WHEEL_RIGHT));
        if (vertical != 0 || horizontal != 0)
            && let Some(event) = source().and_then(|s| CGEvent::new_scroll_event(s, ScrollEventUnit::LINE, 2, vertical, horizontal, 0).ok())
        {
            event.set_flags(self.flags);
            event.post(CGEventTapLocation::HID);
        }
        self.mask = mask;
    }

    /// Lets go of every button and modifier still down.
    pub fn release(&mut self) {
        if self.mask & (LEFT | MIDDLE | RIGHT) != 0 {
            let g = self.geometry;
            let x = (self.at.x - g.origin.0) / (g.size.0 - 1.0).max(1.0) * g.width as f64;
            let y = (self.at.y - g.origin.1) / (g.size.1 - 1.0).max(1.0) * g.height as f64;
            self.pointer(x, y, 0);
        }
        for keysym in [0xffe1, 0xffe3, 0xffe9, 0xffeb] {
            if let Some((_, flag)) = modifier(keysym)
                && self.flags.contains(flag)
            {
                self.key(keysym, false);
            }
        }
    }

    fn mouse(&self, kind: CGEventType, button: CGMouseButton, clicks: Option<i64>) {
        let Some(event) = source().and_then(|s| CGEvent::new_mouse_event(s, kind, self.at, button).ok()) else {
            return;
        };
        if let Some(clicks) = clicks {
            event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, clicks);
        }
        event.set_flags(self.flags);
        event.post(CGEventTapLocation::HID);
    }

    /// The key `keysym` going down or up.
    pub fn key(&mut self, keysym: u32, down: bool) {
        if let Some((code, flag)) = modifier(keysym) {
            if down {
                self.flags |= flag;
            } else {
                self.flags.remove(flag);
            }
            if let Some(event) = source().and_then(|s| CGEvent::new_keyboard_event(s, code, down).ok()) {
                event.set_type(CGEventType::FlagsChanged);
                event.set_flags(self.flags);
                event.post(CGEventTapLocation::HID);
            }
            return;
        }
        let (code, shift, text) = match named(keysym) {
            Some(code) => (code, false, None),
            None => {
                let Some(char) = character(keysym) else { return };
                match us_key(char) {
                    Some((code, shift)) => (code, shift, Some(char)),
                    None => (0, false, Some(char)),
                }
            }
        };
        let Some(event) = source().and_then(|s| CGEvent::new_keyboard_event(s, code, down).ok()) else {
            return;
        };
        let mut flags = self.flags | own_flags(code);
        if shift {
            flags |= CGEventFlags::CGEventFlagShift;
        }
        // A shortcut is matched by its key; anything else types exactly the character sent,
        // whatever the Mac's keyboard layout.
        let shortcut = self.flags.intersects(CGEventFlags::CGEventFlagCommand | CGEventFlags::CGEventFlagControl);
        if let (Some(char), false) = (text, shortcut) {
            event.set_string(char.encode_utf8(&mut [0; 4]));
        }
        event.set_flags(flags);
        event.post(CGEventTapLocation::HID);
    }
}

fn source() -> Option<CGEventSource> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()
}

fn modifier(keysym: u32) -> Option<(u16, CGEventFlags)> {
    Some(match keysym {
        0xffe1 => (56, CGEventFlags::CGEventFlagShift),
        0xffe2 => (60, CGEventFlags::CGEventFlagShift),
        0xffe3 => (59, CGEventFlags::CGEventFlagControl),
        0xffe4 => (62, CGEventFlags::CGEventFlagControl),
        0xffe9 => (58, CGEventFlags::CGEventFlagAlternate),
        0xffea => (61, CGEventFlags::CGEventFlagAlternate),
        // Super and Meta are Command, as Apple's own screen sharing takes them.
        0xffe7 | 0xffeb => (55, CGEventFlags::CGEventFlagCommand),
        0xffe8 | 0xffec => (54, CGEventFlags::CGEventFlagCommand),
        _ => return None,
    })
}

/// The fn (and, on arrows, numeric pad) flags a Mac keyboard sets itself; system shortcuts
/// such as Control and an arrow between Spaces are registered with them.
fn own_flags(code: u16) -> CGEventFlags {
    match code {
        123..=126 => CGEventFlags::CGEventFlagSecondaryFn | CGEventFlags::CGEventFlagNumericPad,
        115 | 116 | 117 | 119 | 121 | 96..=103 | 105..=111 | 118 | 120 | 122 => CGEventFlags::CGEventFlagSecondaryFn,
        _ => CGEventFlags::CGEventFlagNull,
    }
}

/// Keys with no character, by their Mac key code.
fn named(keysym: u32) -> Option<u16> {
    Some(match keysym {
        0xff08 => 51,
        0xff09 => 48,
        0xff0d | 0xff8d => 36,
        0xff1b => 53,
        0xff50 => 115,
        0xff51 => 123,
        0xff52 => 126,
        0xff53 => 124,
        0xff54 => 125,
        0xff55 => 116,
        0xff56 => 121,
        0xff57 => 119,
        0xffff => 117,
        0xffe5 => 57,
        0xffbe..=0xffc9 => [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111][(keysym - 0xffbe) as usize],
        _ => return None,
    })
}

/// The character a keysym types: Latin-1 as itself, anything else as `0x01000000` plus its
/// code point.
fn character(keysym: u32) -> Option<char> {
    match keysym {
        0x20..=0x7e | 0xa0..=0xff => char::from_u32(keysym),
        0x0100_0000..=0x0110_ffff => char::from_u32(keysym - 0x0100_0000),
        _ => None,
    }
}

/// Where a character sits on a US keyboard, and whether it needs Shift.
fn us_key(c: char) -> Option<(u16, bool)> {
    const PLAIN: &str = "asdfhgzxcv\0bqweryt123465=97-80]ou[ip\0lj'k;\\,/nm.\0\0`";
    const SHIFTED: &str = "ASDFHGZXCV\0BQWERYT!@#$^%+(&_*)}OU{IP\0LJ\"K:|<?NM>\0\0~";
    if c == ' ' {
        return Some((49, false));
    }
    if c == '\0' {
        return None;
    }
    if let Some(i) = PLAIN.chars().position(|p| p == c) {
        return Some((i as u16, false));
    }
    SHIFTED.chars().position(|p| p == c).map(|i| (i as u16, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn us_keys_match_the_mac_key_codes() {
        assert_eq!(us_key('a'), Some((0, false)));
        assert_eq!(us_key('c'), Some((8, false)));
        assert_eq!(us_key('v'), Some((9, false)));
        assert_eq!(us_key('q'), Some((12, false)));
        assert_eq!(us_key('1'), Some((18, false)));
        assert_eq!(us_key('5'), Some((23, false)));
        assert_eq!(us_key('0'), Some((29, false)));
        assert_eq!(us_key('l'), Some((37, false)));
        assert_eq!(us_key('/'), Some((44, false)));
        assert_eq!(us_key('m'), Some((46, false)));
        assert_eq!(us_key('`'), Some((50, false)));
        assert_eq!(us_key('A'), Some((0, true)));
        assert_eq!(us_key('?'), Some((44, true)));
        assert_eq!(us_key('%'), Some((23, true)));
        assert_eq!(us_key(' '), Some((49, false)));
        assert_eq!(us_key('é'), None);
    }

    #[test]
    fn arrows_carry_fn_as_a_mac_keyboard_sends_them() {
        let left = own_flags(named(0xff51).unwrap());
        assert!(left.contains(CGEventFlags::CGEventFlagSecondaryFn | CGEventFlags::CGEventFlagNumericPad));
        assert!(own_flags(named(0xffbe).unwrap()).contains(CGEventFlags::CGEventFlagSecondaryFn));
        assert_eq!(own_flags(us_key('a').unwrap().0), CGEventFlags::CGEventFlagNull);
        assert_eq!(own_flags(named(0xff0d).unwrap()), CGEventFlags::CGEventFlagNull);
    }

    #[test]
    fn keysyms_name_their_characters() {
        assert_eq!(character(0x61), Some('a'));
        assert_eq!(character(0xe9), Some('é'));
        assert_eq!(character(0x0100_3042), Some('あ'));
        assert_eq!(character(0xff0d), None);
        assert_eq!(named(0xff0d), Some(36));
        assert_eq!(named(0xffc9), Some(111));
    }
}
