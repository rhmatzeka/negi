//! Windows that phones have sized for themselves. Several phones can show one pane: the
//! window keeps the size of the one that asked last, and goes back to tmux only once none
//! of them is left, so one phone closing never shrinks the window under another.

use std::collections::HashMap;
use std::sync::Mutex;

/// What the window should do after a phone lets go of it.
#[derive(Debug, PartialEq, Eq)]
pub enum After {
    /// Another phone still holds it, and it now takes that one's size.
    Size(u16, u16),
    /// Nobody holds it: tmux sizes it from its clients again.
    Free,
    /// The phone that let go was not the one whose size the window has.
    Keep,
}

/// A phone's socket, with the columns and rows it asked for.
type Holder = (u64, u16, u16);

#[derive(Default)]
pub struct Fits(Mutex<HashMap<String, Vec<Holder>>>);

impl Fits {
    /// `client` has sized `pane`'s window to `cols` x `rows`.
    pub fn hold(&self, pane: &str, client: u64, cols: u16, rows: u16) {
        let Ok(mut all) = self.0.lock() else { return };
        let holders = all.entry(pane.to_owned()).or_default();
        holders.retain(|(c, ..)| *c != client);
        holders.push((client, cols, rows));
    }

    /// `client` no longer shows `pane` fitted.
    pub fn release(&self, pane: &str, client: u64) -> After {
        let Ok(mut all) = self.0.lock() else {
            return After::Keep;
        };
        let Some(holders) = all.get_mut(pane) else {
            return After::Keep;
        };
        let Some(at) = holders.iter().position(|(c, ..)| *c == client) else {
            return After::Keep;
        };
        let was_last = at + 1 == holders.len();
        holders.remove(at);
        match holders.last() {
            None => {
                all.remove(pane);
                After::Free
            }
            Some(&(_, cols, rows)) if was_last => After::Size(cols, rows),
            Some(_) => After::Keep,
        }
    }

    /// Every pane `client` held, for when its socket ends.
    pub fn held_by(&self, client: u64) -> Vec<String> {
        self.0.lock().map_or_else(
            |_| Vec::new(),
            |all| {
                all.iter()
                    .filter(|(_, holders)| holders.iter().any(|(c, ..)| *c == client))
                    .map(|(pane, _)| pane.clone())
                    .collect()
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_phone_gives_the_window_back() {
        let fits = Fits::default();
        fits.hold("%1", 1, 80, 30);
        assert_eq!(fits.release("%1", 1), After::Free);
        assert_eq!(fits.release("%1", 1), After::Keep);
    }

    #[test]
    fn the_last_to_leave_frees_it_and_the_size_falls_back() {
        let fits = Fits::default();
        fits.hold("%1", 1, 120, 33);
        fits.hold("%1", 2, 40, 20);
        // The phone whose size the window has leaves: the desktop's size comes back.
        assert_eq!(fits.release("%1", 2), After::Size(120, 33));
        assert_eq!(fits.release("%1", 1), After::Free);
    }

    #[test]
    fn an_earlier_phone_leaving_changes_nothing() {
        let fits = Fits::default();
        fits.hold("%1", 1, 120, 33);
        fits.hold("%1", 2, 40, 20);
        assert_eq!(fits.release("%1", 1), After::Keep);
        assert_eq!(fits.held_by(2), vec!["%1".to_owned()]);
        assert!(fits.held_by(1).is_empty());
    }

    #[test]
    fn asking_again_moves_a_phone_to_the_front() {
        let fits = Fits::default();
        fits.hold("%1", 1, 120, 33);
        fits.hold("%1", 2, 40, 20);
        fits.hold("%1", 1, 118, 33);
        assert_eq!(fits.release("%1", 1), After::Size(40, 20));
    }
}
