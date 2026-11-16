//! What changed between two captures of a pane, so a phone is sent rows, not screens.

use serde_json::{Value, json};

use crate::tmux::mux::Screen;

#[derive(Debug, PartialEq, Eq)]
pub enum Delta {
    /// The size or the screen kind changed: send everything.
    Full,
    /// Drop `scroll` rows from the top, add as many empty rows at the bottom, then
    /// replace the rows in `set`.
    Rows {
        scroll: usize,
        set: Vec<(usize, String)>,
    },
}

/// `None` when nothing a viewer could see differs.
pub fn delta(old: &Screen, new: &Screen) -> Option<Delta> {
    if old == new {
        return None;
    }
    if (old.cols, old.rows, old.alt) != (new.cols, new.rows, new.alt)
        || old.lines.len() != new.lines.len()
    {
        return Some(Delta::Full);
    }
    let rows = new.lines.len();
    // Rows that differ once the old screen has moved up by `k`.
    let changed = |k: usize| -> Vec<usize> {
        (0..rows)
            .filter(|&i| {
                old.lines
                    .get(i + k)
                    .is_none_or(|line| *line != new.lines[i])
            })
            .collect()
    };
    let mut best = (0, changed(0));
    // Output that scrolls moves every row, so a plain comparison would resend them all.
    if best.1.len() > 2 {
        for k in 1..rows {
            let set = changed(k);
            if set.len() < best.1.len() {
                best = (k, set);
            }
        }
    }
    let (scroll, set) = best;
    Some(Delta::Rows {
        scroll,
        set: set.into_iter().map(|i| (i, new.lines[i].clone())).collect(),
    })
}

pub fn full_message(pane: &str, screen: &Screen) -> Value {
    json!({
        "t": "screen",
        "pane": pane,
        "cols": screen.cols,
        "rows": screen.rows,
        "alt": screen.alt,
        "cur": cursor(screen),
        "lines": screen.lines,
    })
}

pub fn rows_message(pane: &str, screen: &Screen, scroll: usize, set: &[(usize, String)]) -> Value {
    json!({ "t": "rows", "pane": pane, "cur": cursor(screen), "scroll": scroll, "set": set })
}

fn cursor(screen: &Screen) -> Value {
    json!([screen.cx, screen.cy, screen.cursor, screen.shape])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(lines: &[&str]) -> Screen {
        Screen {
            cols: 80,
            rows: lines.len() as u16,
            cx: 0,
            cy: 0,
            cursor: true,
            shape: String::new(),
            alt: false,
            lines: lines.iter().map(|l| (*l).to_owned()).collect(),
        }
    }

    /// What the phone does with a `rows` message.
    fn apply(old: &Screen, delta: &Delta) -> Vec<String> {
        let Delta::Rows { scroll, set } = delta else {
            panic!("not rows")
        };
        let mut lines: Vec<String> = old.lines[*scroll..].to_vec();
        lines.resize(old.lines.len(), String::new());
        for (i, text) in set {
            lines[*i] = text.clone();
        }
        lines
    }

    #[test]
    fn nothing_changed() {
        let a = screen(&["one", "two"]);
        assert_eq!(delta(&a, &a.clone()), None);
    }

    #[test]
    fn only_the_cursor_moved() {
        let a = screen(&["one", "two"]);
        let mut b = a.clone();
        b.cx = 3;
        assert_eq!(
            delta(&a, &b),
            Some(Delta::Rows {
                scroll: 0,
                set: vec![]
            })
        );
    }

    #[test]
    fn one_row_changed() {
        let a = screen(&["$ ", "", "", ""]);
        let b = screen(&["$ ls", "", "", ""]);
        assert_eq!(
            delta(&a, &b),
            Some(Delta::Rows {
                scroll: 0,
                set: vec![(0, "$ ls".into())]
            })
        );
    }

    #[test]
    fn scrolling_sends_only_the_new_rows() {
        let a = screen(&["a", "b", "c", "d", "e", "f"]);
        let b = screen(&["c", "d", "e", "f", "g", "h"]);
        let d = delta(&a, &b).unwrap();
        assert_eq!(
            d,
            Delta::Rows {
                scroll: 2,
                set: vec![(4, "g".into()), (5, "h".into())]
            }
        );
        assert_eq!(apply(&a, &d), b.lines);
    }

    #[test]
    fn scrolling_with_a_fixed_footer_still_round_trips() {
        let a = screen(&["a", "b", "c", "d", "status 1"]);
        let b = screen(&["b", "c", "d", "e", "status 2"]);
        let d = delta(&a, &b).unwrap();
        assert_eq!(apply(&a, &d), b.lines);
        let Delta::Rows { set, .. } = &d else {
            unreachable!()
        };
        assert!(set.len() < 5, "fewer rows than the whole screen: {set:?}");
    }

    #[test]
    fn a_full_redraw_round_trips() {
        let a = screen(&["a", "b", "c"]);
        let b = screen(&["x", "y", "z"]);
        let d = delta(&a, &b).unwrap();
        assert_eq!(apply(&a, &d), b.lines);
    }

    #[test]
    fn a_resize_or_a_screen_switch_is_sent_whole() {
        let a = screen(&["a", "b"]);
        assert_eq!(delta(&a, &screen(&["a", "b", "c"])), Some(Delta::Full));
        let mut wide = a.clone();
        wide.cols = 120;
        assert_eq!(delta(&a, &wide), Some(Delta::Full));
        let mut alt = a.clone();
        alt.alt = true;
        assert_eq!(delta(&a, &alt), Some(Delta::Full));
    }
}
