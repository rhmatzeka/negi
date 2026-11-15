//! Paired devices and the pending pairing code, as small files in the state folder: the
//! only place the CLI and the server, separate processes, meet.

use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CODE_LEN: usize = 8;
/// 32 symbols, so a byte maps to one without bias. No I or O, which read as 1 and 0.
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
pub const CODE_SECONDS: u64 = 600;
/// Wrong guesses a code survives. Eight symbols are 40 bits; this keeps it that way.
const CODE_TRIES: u32 = 8;
const MAX_DEVICES: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub label: String,
    /// SHA-256 of the token. The token itself is never stored.
    pub hash: String,
    pub created: u64,
    /// Who paired it: the tailnet login, or "this computer" when it came over loopback.
    #[serde(default)]
    pub via: String,
    /// The browser it paired from, shortened ("Safari on iPhone").
    #[serde(default)]
    pub agent: String,
    /// SHA-256 of the code it was paired with, so `negi pair` can tell its own code was used.
    #[serde(default)]
    pub code: String,
}

/// Where a pairing request came from, as the server saw it.
#[derive(Debug, Default, Clone)]
pub struct Origin {
    pub via: String,
    pub agent: String,
}

/// How the code `negi pair` is showing stands.
#[derive(Debug, PartialEq, Eq)]
pub enum Pairing {
    Waiting { expires: u64, tries: u32 },
    Paired(Device),
    /// Another `negi pair` has put its own code in place of this one.
    Replaced,
    Expired,
    /// Too many wrong guesses: the code was dropped.
    UsedUp,
}

#[derive(Debug, Serialize, Deserialize)]
struct Pending {
    hash: String,
    expires: u64,
    tries: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PairError {
    /// No code, an expired one, or a wrong one. The caller is not told which.
    Refused,
    BadLabel,
    Full,
    Io(String),
}

pub struct Store {
    dir: PathBuf,
    // Serialises read-modify-write within this process.
    lock: Mutex<()>,
}

impl Store {
    pub fn open(dir: impl Into<PathBuf>) -> io::Result<Self> {
        let dir = dir.into();
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)?;
        Ok(Self {
            dir,
            lock: Mutex::new(()),
        })
    }

    /// `$NEGI_STATE`, else `$XDG_STATE_HOME/negi`, else `~/.local/state/negi`.
    pub fn default_dir() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("NEGI_STATE") {
            return Some(dir.into());
        }
        if let Some(dir) = std::env::var_os("XDG_STATE_HOME").filter(|d| !d.is_empty()) {
            return Some(PathBuf::from(dir).join("negi"));
        }
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state/negi"))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn devices(&self) -> Vec<Device> {
        read(&self.dir.join("devices.json")).unwrap_or_default()
    }

    /// Starts a pairing and returns the code to show. Replaces any code still pending.
    pub fn start_pairing(&self) -> io::Result<String> {
        let mut bytes = [0u8; CODE_LEN];
        random(&mut bytes)?;
        let code: String = bytes
            .iter()
            .map(|b| CODE_ALPHABET[(b & 31) as usize] as char)
            .collect();
        let pending = Pending {
            hash: sha256(&code),
            expires: now() + CODE_SECONDS,
            tries: 0,
        };
        write(&self.dir.join("pair.json"), &pending)?;
        Ok(code)
    }

    /// How the code `negi pair` showed stands now.
    pub fn pairing(&self, code: &str) -> Pairing {
        let hash = sha256(code);
        let path = self.dir.join("pair.json");
        match read::<Pending>(&path) {
            Some(p) if !same(&p.hash, &hash) => Pairing::Replaced,
            Some(p) if p.expires <= now() => {
                let _ = fs::remove_file(&path);
                Pairing::Expired
            }
            Some(p) => Pairing::Waiting {
                expires: p.expires,
                tries: p.tries,
            },
            None => match self.devices().into_iter().find(|d| same(&d.code, &hash)) {
                Some(device) => Pairing::Paired(device),
                None => Pairing::UsedUp,
            },
        }
    }

    /// Drops the pending code if it is still this one. Another `negi pair`'s code is left alone.
    pub fn cancel_pairing(&self, code: &str) -> io::Result<bool> {
        let _guard = self.lock.lock().unwrap();
        let path = self.dir.join("pair.json");
        match read::<Pending>(&path) {
            Some(p) if same(&p.hash, &sha256(code)) => fs::remove_file(&path).map(|()| true),
            _ => Ok(false),
        }
    }

    /// Trades a pairing code for a device token. The code works once.
    pub fn redeem(&self, code: &str, label: &str) -> Result<String, PairError> {
        self.redeem_from(code, label, &Origin::default())
    }

    /// As `redeem`, noting where the request came from.
    pub fn redeem_from(&self, code: &str, label: &str, origin: &Origin) -> Result<String, PairError> {
        let label = label.trim();
        if label.is_empty() || label.chars().count() > 40 || label.chars().any(char::is_control) {
            return Err(PairError::BadLabel);
        }
        let _guard = self.lock.lock().unwrap();
        let path = self.dir.join("pair.json");
        let Some(mut pending) = read::<Pending>(&path) else {
            return Err(PairError::Refused);
        };
        if pending.expires <= now() {
            let _ = fs::remove_file(&path);
            return Err(PairError::Refused);
        }
        let given: String = code
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .map(|c| c.to_ascii_uppercase())
            .collect();
        if !same(&sha256(&given), &pending.hash) {
            pending.tries += 1;
            let _ = if pending.tries >= CODE_TRIES {
                fs::remove_file(&path)
            } else {
                write(&path, &pending)
            };
            return Err(PairError::Refused);
        }
        let _ = fs::remove_file(&path);

        let mut devices = self.devices();
        if devices.len() >= MAX_DEVICES {
            return Err(PairError::Full);
        }
        let mut raw = [0u8; 36];
        random(&mut raw).map_err(|e| PairError::Io(e.to_string()))?;
        let token = hex(&raw[..32]);
        devices.push(Device {
            id: hex(&raw[32..]),
            label: label.to_owned(),
            hash: sha256(&token),
            created: now(),
            via: origin.via.clone(),
            agent: origin.agent.clone(),
            code: sha256(&given),
        });
        write(&self.dir.join("devices.json"), &devices)
            .map_err(|e| PairError::Io(e.to_string()))?;
        Ok(token)
    }

    /// The device this token belongs to, if it is still paired.
    pub fn device(&self, token: &str) -> Option<Device> {
        let hash = sha256(token);
        // Every entry is compared, so timing does not reveal which one matched.
        self.devices().into_iter().fold(
            None,
            |found, d| if same(&d.hash, &hash) { Some(d) } else { found },
        )
    }

    pub fn revoke(&self, id: &str) -> io::Result<bool> {
        let _guard = self.lock.lock().unwrap();
        let mut devices = self.devices();
        let before = devices.len();
        devices.retain(|d| d.id != id);
        if devices.len() == before {
            return Ok(false);
        }
        write(&self.dir.join("devices.json"), &devices)?;
        Ok(true)
    }

    /// Encrypts something for one device to keep. Only this server opens it, and only for
    /// that device, so a copy taken from the phone is noise.
    pub fn seal(&self, device: &str, plain: &[u8]) -> io::Result<String> {
        let cipher = ChaCha20Poly1305::new(&Key::from(self.secret()?));
        let mut nonce = [0u8; 12];
        random(&mut nonce)?;
        let sealed = cipher
            .encrypt(&Nonce::from(nonce), Payload { msg: plain, aad: device.as_bytes() })
            .map_err(|_| io::Error::other("sealing failed"))?;
        Ok(hex(&[&nonce[..], &sealed].concat()))
    }

    /// Opens what `seal` gave the same device; `None` for anything else.
    pub fn unseal(&self, device: &str, sealed: &str) -> Option<Vec<u8>> {
        let bytes = unhex(sealed)?;
        if bytes.len() < 12 + 16 {
            return None;
        }
        let (nonce, body) = bytes.split_at(12);
        let cipher = ChaCha20Poly1305::new(&Key::from(self.secret().ok()?));
        cipher
            .decrypt(&Nonce::from(<[u8; 12]>::try_from(nonce).ok()?), Payload { msg: body, aad: device.as_bytes() })
            .ok()
    }

    /// This server's own key for `seal`, made on first use. It never leaves the state folder.
    fn secret(&self) -> io::Result<[u8; 32]> {
        let path = self.dir.join("seal.key");
        if let Ok(bytes) = fs::read(&path) {
            return <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| io::Error::other("seal.key is damaged"));
        }
        let mut key = [0u8; 32];
        random(&mut key)?;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)?;
        file.write_all(&key)?;
        Ok(key)
    }

    /// Appends one line about a write to the audit file: who, what kind, how much. Never
    /// the text itself.
    pub fn audit(&self, device: &str, what: &str) {
        let line = format!("{} {device} {what}\n", now());
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(self.dir.join("audit.log"));
        if let Ok(mut file) = file {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

fn read<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Writes through a temporary file and a rename, so a reader in another process sees the
/// old file or the new one, never half of one.
fn write<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    fs::rename(&tmp, path)
}

fn random(buf: &mut [u8]) -> io::Result<()> {
    getrandom::fill(buf).map_err(|e| io::Error::other(e.to_string()))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok()).collect()
}

pub fn sha256(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

/// Compares without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn scratch() -> (Store, PathBuf) {
        let mut raw = [0u8; 8];
        random(&mut raw).unwrap();
        let dir = std::env::temp_dir().join(format!("negi-store-{}", hex(&raw)));
        (Store::open(&dir).unwrap(), dir)
    }

    #[test]
    fn negi_pair_sees_its_code_used_replaced_or_cancelled() {
        let (store, _dir) = scratch();
        let code = store.start_pairing().unwrap();
        assert!(matches!(store.pairing(&code), Pairing::Waiting { tries: 0, .. }));
        let origin = Origin { via: "me@example.com".into(), agent: "Safari on iPhone".into() };
        store.redeem_from(&code, "phone", &origin).unwrap();
        match store.pairing(&code) {
            Pairing::Paired(d) => assert_eq!((d.label.as_str(), d.via.as_str(), d.agent.as_str()), ("phone", "me@example.com", "Safari on iPhone")),
            other => panic!("{other:?}"),
        }

        let first = store.start_pairing().unwrap();
        let second = store.start_pairing().unwrap();
        assert_eq!(store.pairing(&first), Pairing::Replaced);
        assert!(!store.cancel_pairing(&first).unwrap(), "leaves the newer code alone");
        assert!(store.cancel_pairing(&second).unwrap());
        assert_eq!(store.redeem(&second, "phone"), Err(PairError::Refused));
        assert_eq!(store.pairing(&second), Pairing::UsedUp);
    }

    #[test]
    fn a_sealed_login_opens_only_for_its_own_device() {
        let (store, _dir) = scratch();
        let sealed = store.seal("aaaa", b"secret").unwrap();
        assert_eq!(store.unseal("aaaa", &sealed).as_deref(), Some(&b"secret"[..]));
        assert_eq!(store.unseal("bbbb", &sealed), None);
        assert_eq!(store.unseal("aaaa", "00ff"), None);
        let mut tampered = sealed.clone();
        tampered.replace_range(30..32, if &sealed[30..32] == "00" { "11" } else { "00" });
        assert_eq!(store.unseal("aaaa", &tampered), None);
        assert_ne!(store.seal("aaaa", b"secret").unwrap(), sealed, "a fresh nonce each time");
    }

    #[test]
    fn a_code_pairs_one_device_once() {
        let (store, dir) = scratch();
        let code = store.start_pairing().unwrap();
        assert_eq!(code.len(), 8);
        assert!(code.bytes().all(|b| CODE_ALPHABET.contains(&b)));

        let token = store.redeem(&code, "phone").unwrap();
        assert_eq!(token.len(), 64);
        assert_eq!(store.device(&token).unwrap().label, "phone");
        assert_eq!(
            store.redeem(&code, "second"),
            Err(PairError::Refused),
            "single use"
        );
        assert!(store.device("not a token").is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_code_is_read_the_way_people_type_it() {
        let (store, dir) = scratch();
        let code = store.start_pairing().unwrap();
        let typed = format!(" {}-{} ", code[..4].to_lowercase(), &code[4..]);
        assert!(store.redeem(&typed, "phone").is_ok());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn wrong_guesses_use_the_code_up() {
        let (store, dir) = scratch();
        let code = store.start_pairing().unwrap();
        for _ in 0..CODE_TRIES {
            assert_eq!(store.redeem("AAAAAAAA", "phone"), Err(PairError::Refused));
        }
        assert_eq!(
            store.redeem(&code, "phone"),
            Err(PairError::Refused),
            "the right code is dead too"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_expired_code_is_refused() {
        let (store, dir) = scratch();
        let code = store.start_pairing().unwrap();
        let path = dir.join("pair.json");
        let mut pending: Pending = read(&path).unwrap();
        pending.expires = now() - 1;
        write(&path, &pending).unwrap();
        assert_eq!(store.redeem(&code, "phone"), Err(PairError::Refused));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn no_pending_code_and_bad_labels_are_refused() {
        let (store, dir) = scratch();
        assert_eq!(store.redeem("ABCDEFGH", "phone"), Err(PairError::Refused));
        let code = store.start_pairing().unwrap();
        assert_eq!(store.redeem(&code, "  "), Err(PairError::BadLabel));
        assert_eq!(store.redeem(&code, "a\nb"), Err(PairError::BadLabel));
        assert_eq!(
            store.redeem(&code, &"x".repeat(41)),
            Err(PairError::BadLabel)
        );
        assert!(
            store.redeem(&code, "phone").is_ok(),
            "a bad label does not burn the code"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_revoked_device_is_gone_and_only_hashes_are_stored() {
        let (store, dir) = scratch();
        let token = store
            .redeem(&store.start_pairing().unwrap(), "phone")
            .unwrap();
        let on_disk = fs::read_to_string(dir.join("devices.json")).unwrap();
        assert!(!on_disk.contains(&token));
        assert!(on_disk.contains(&sha256(&token)));

        let id = store.device(&token).unwrap().id;
        assert!(store.revoke(&id).unwrap());
        assert!(store.device(&token).is_none());
        assert!(!store.revoke(&id).unwrap());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn nothing_here_is_readable_by_other_users() {
        let (store, dir) = scratch();
        store
            .redeem(&store.start_pairing().unwrap(), "phone")
            .unwrap();
        store.start_pairing().unwrap();
        store.audit("abcd", "keys %1 2");
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        for file in ["devices.json", "pair.json", "audit.log"] {
            assert_eq!(mode(&dir.join(file)), 0o600, "{file}");
        }
        let _ = fs::remove_dir_all(dir);
    }
}
