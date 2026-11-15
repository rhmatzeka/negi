//! Keeps the Mac from sleeping for idleness while a phone is connected, so a remote session
//! is not cut off by the Mac dozing off untouched. Closing the lid still sleeps it.

/// The assertion; released when dropped.
pub struct Awake(#[cfg_attr(not(target_os = "macos"), allow(dead_code))] u32);

#[cfg(target_os = "macos")]
mod mac {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        pub fn IOPMAssertionCreateWithName(kind: CFStringRef, level: u32, name: CFStringRef, id: *mut u32) -> i32;
        pub fn IOPMAssertionRelease(id: u32) -> i32;
    }

    /// `kIOPMAssertionLevelOn`.
    const ON: u32 = 255;

    pub fn create() -> Option<u32> {
        let kind = CFString::from_static_string("PreventUserIdleSystemSleep");
        let name = CFString::from_static_string("negi: a phone is connected");
        let mut id = 0;
        let made = unsafe { IOPMAssertionCreateWithName(kind.as_concrete_TypeRef(), ON, name.as_concrete_TypeRef(), &mut id) };
        (made == 0).then_some(id)
    }
}

impl Awake {
    pub fn hold() -> Option<Self> {
        #[cfg(target_os = "macos")]
        let id = mac::create()?;
        #[cfg(not(target_os = "macos"))]
        let id = 0;
        Some(Self(id))
    }
}

impl Drop for Awake {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        unsafe {
            mac::IOPMAssertionRelease(self.0);
        }
    }
}
