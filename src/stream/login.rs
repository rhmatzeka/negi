//! The Mac's own password, checked by macOS (PAM, the `checkpw` service that Open Directory
//! answers) for the account negi runs as. Nothing here keeps it.

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::ptr;

#[repr(C)]
struct Message {
    style: c_int,
    msg: *const c_char,
}

#[repr(C)]
struct Response {
    resp: *mut c_char,
    retcode: c_int,
}

#[repr(C)]
struct Conversation {
    conv: extern "C" fn(c_int, *mut *const Message, *mut *mut Response, *mut c_void) -> c_int,
    data: *mut c_void,
}

const SUCCESS: c_int = 0;
/// OpenPAM's item for the password itself.
const AUTHTOK: c_int = 6;
const CONV_ERR: c_int = 19;
const PROMPT_ECHO_OFF: c_int = 1;

#[link(name = "pam")]
unsafe extern "C" {
    fn pam_start(service: *const c_char, user: *const c_char, conv: *const Conversation, handle: *mut *mut c_void) -> c_int;
    fn pam_authenticate(handle: *mut c_void, flags: c_int) -> c_int;
    fn pam_set_item(handle: *mut c_void, item: c_int, value: *const c_void) -> c_int;
    fn pam_acct_mgmt(handle: *mut c_void, flags: c_int) -> c_int;
    fn pam_end(handle: *mut c_void, status: c_int) -> c_int;
}

unsafe extern "C" {
    fn calloc(count: usize, size: usize) -> *mut c_void;
    fn strdup(s: *const c_char) -> *mut c_char;
}

/// Answers PAM's password prompt with the password given; PAM frees what is handed over.
extern "C" fn answer(count: c_int, messages: *mut *const Message, out: *mut *mut Response, data: *mut c_void) -> c_int {
    if count <= 0 || data.is_null() {
        return CONV_ERR;
    }
    unsafe {
        let responses = calloc(count as usize, size_of::<Response>()) as *mut Response;
        if responses.is_null() {
            return CONV_ERR;
        }
        for i in 0..count as usize {
            let message = *messages.add(i);
            if !message.is_null() && (*message).style == PROMPT_ECHO_OFF {
                (*responses.add(i)).resp = strdup(data as *const c_char);
            }
        }
        *out = responses;
    }
    SUCCESS
}

/// The account negi runs as, whose screen live video shows.
pub fn account() -> Option<String> {
    unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() {
            return None;
        }
        CStr::from_ptr((*entry).pw_name).to_str().ok().map(str::to_owned)
    }
}

/// Whether `password` is this account's password, as macOS itself decides.
pub fn check(password: &str) -> bool {
    verify(password) == Ok(true)
}

/// `Err` when macOS could not be asked at all, as apart from a wrong password.
fn verify(password: &str) -> Result<bool, &'static str> {
    let user = account().ok_or("no account")?;
    let secret = CString::new(password).map_err(|_| "a NUL in the password")?;
    let user = CString::new(user).map_err(|_| "a NUL in the account")?;
    let service = CString::new("checkpw").expect("no NUL");
    let conversation = Conversation { conv: answer, data: secret.as_ptr() as *mut c_void };
    let mut handle = ptr::null_mut();
    unsafe {
        if pam_start(service.as_ptr(), user.as_ptr(), &conversation, &mut handle) != SUCCESS {
            return Err("PAM did not start");
        }
        // `checkpw` takes the password already given (`use_first_pass`) and never asks the
        // conversation; without it set here every password reads as wrong.
        if pam_set_item(handle, AUTHTOK, secret.as_ptr().cast()) != SUCCESS {
            pam_end(handle, SUCCESS);
            return Err("PAM took no password");
        }
        let mut status = pam_authenticate(handle, 0);
        if status == SUCCESS {
            status = pam_acct_mgmt(handle, 0);
        }
        pam_end(handle, status);
        Ok(status == SUCCESS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Asks Open Directory for real, which counts toward the account's failed attempts: run by
    // hand with `--ignored`, not on every test run.
    #[test]
    #[ignore]
    fn a_wrong_password_is_refused() {
        assert!(account().is_some());
        assert_eq!(verify("certainly-not-the-password-7f3c"), Ok(false));
    }
}
