# negi spec

tmux in a phone browser, for the one person who owns the machine. One Rust binary, tmux
only, reached over a tailnet.

Every statement about tmux below comes from `man tmux` or from a test in this repository
that runs against a real tmux. Developed against tmux 3.8; no older version has been tried.

## Scope

In:

- Browse sessions, windows and panes.
- Read a pane's screen with colour, and its history.
- Type text and press keys.
- Make, rename and close sessions and windows; close panes.
- Live updates, for the open pane and for previews of the others.
- Which panes are busy (printing) and which went quiet.
- Pairing, so only approved devices can read or type.

Not yet: an installer and notifications. See Milestones.

Out: anything that is not tmux. negi does not know what runs inside a pane and has no
per-program logic.

## Architecture

```
phone browser
   |  HTTPS, tailnet only
tailnet proxy                       adds the caller's tailnet login as a header
   |  http://127.0.0.1:<port>
negi                             one process, binds loopback only
   |  one `tmux -C` client per session, kept open while a phone is connected
tmux server
```

Modules, bottom up, each tested alone:

| Module | Does |
| --- | --- |
| `tmux` | Finds the binary, builds its arguments, quotes command text |
| `tmux::proto` | Parses control mode lines |
| `tmux::link` | One control client: commands in, replies and notifications out |
| `tmux::mux` | Typed operations over a link: tree, screen, history, keys, text, structure |
| `tmux::screen` | Row-level difference between two captures |
| `hub` | Owns the links, decides what each phone is told |
| `store` | Paired devices and the pending pairing code |
| `server` | The routes, the page, pairing |
| `server::guard` | Admission rules: host, tailnet login, origin |
| `server::socket` | One device's WebSocket: what it may ask and how it is answered |

The interface in `web/src`:

| Folder | Holds |
| --- | --- |
| `app` | The router, the pages, what runs before the first paint |
| `connection` | The socket to the server, requests over it, connection state, sample data |
| `tmux` | The session tree, a pane's screen, which icon a program gets |
| `features/sessions` | The session list, the summary card and its character |
| `features/pane` | The pane view, the terminal, the key row |
| `features/sheets` | One file per sheet, and the parts they share |
| `components` | Shared pieces: confirm button, field, tooltip, tile, state page, `ui/` primitives |
| `lib` | The store, themes, animation setup, small helpers |

## tmux, as negi uses it

### One control client per session

`tmux -u -C attach-session -t $N -f ignore-size`.

- A control client reports `%output` only for panes of the session it is attached to
  (test: `panes_of_every_session_report_not_only_the_first`). Hence one client per session.
- `ignore-size` keeps the client from resizing windows
  (test: `a_link_reports_output_and_structure_and_never_resizes`).
- `-u` is required. `man tmux`, LC_CTYPE: without a UTF-8 locale and without `-u`,
  non-ASCII characters are replaced with underscores. A launchd service has no such locale.
- When a session closes, its client exits, or tmux moves it to another session
  (`%session-changed`). The hub drops a moved client: two clients on one session would
  report every output twice.
- tmux's `session_attached` counts control clients. The tree's `attached` comes from
  `list-clients` with `#{client_control_mode}` instead, so it means a real terminal.

### Commands and replies

- One command per line on stdin, one `%begin ... %end` or `%error` block back per line.
  Never a `;` sequence: tmux stops at the first error, which would leave fewer replies
  than commands and misalign every reply after it.
- A block is matched to its `%begin` by the whole tag (time, command number, flags). A pane
  can print `%end 1 2 3` or `%output %0 x`; inside a block that is just text
  (test: `a_pane_cannot_forge_the_end_of_a_reply`).
- The last number of the tag is 1 for a reply to this client's command and 0 for blocks
  tmux emits on its own, such as the one for the attach. Observed, not documented:
  `man tmux` calls the flags unused.
- Replies are answered in the order commands were written; a caller that times out
  leaves its slot in the queue so later replies still line up.

### Listing

One batch of four commands: `list-sessions`, `list-windows -a`, `list-panes -a`,
`list-clients`, each with a `-F` format whose fields are separated by U+001F. Free text
(the pane title) goes last and keeps any separator it contains.

### Screens

`display-message -p -t %N` for size, cursor and alternate-screen flag, then
`capture-pane -p -e -t %N`. The capture has exactly one line per row. History is
`capture-pane -p -e -S -N -E -1`. A pane on the alternate screen has no history.

### Text

Text is sent as hex bytes: `send-keys -t %N -H 68 69`. Nothing in the text is parsed by
tmux, so there is no quoting to get wrong (test: `text_arrives_exactly_as_typed`).

- At most 256 bytes per command. A command with thousands of arguments fails with
  `parse error: yacc stack overflow` (seen with 20,000).
- Line breaks become carriage returns, as a keyboard sends them. Control characters other
  than tab are dropped.
- Text with line breaks is wrapped in `ESC[200~` and `ESC[201~` when `#{bracket_paste_flag}`
  is 1, so a program that asked for bracketed paste gets one paste and not one submission
  per line (test: `several_lines_are_one_paste_only_where_the_program_asked`).
- Enter follows 150 ms after the text. That pause is a guess, not a measurement.

### Keys

`send-keys -t %N -- <names>`. A name is modifiers (`C-`, `M-`, `S-`) plus a named key or one
printable ASCII character; anything else is refused before it reaches tmux.

### Targets and names

- Targets are tmux's own ids only: `%N`, `@N`, `$N`. Target syntax such as `work:1.2` or
  `{last}` is refused (test: `nothing_but_ids_and_key_names_reaches_tmux`).
- tmux expands formats in the names and folders given to `rename-window`,
  `rename-session`, `new-window -n`, `new-session -s` and `-c`: `#{pane_id}` becomes an id
  and `#(cmd)` runs a command. negi doubles every `#` so the text stays literal
  (test: `windows_and_sessions_can_be_made_renamed_and_closed`).
- Names are 1 to 64 characters with no control characters. A new window is created with
  `-d`, so it never changes what a terminal is showing.

## The hub

While at least one phone is connected:

- One link per session, up to 24. Sessions beyond that get no live updates.
- `%output %N` marks pane N as changed and as busy. A changed pane that someone has open is
  captured at most every 50 ms; one shown as a preview at most every second.
- An open pane is also captured every 5 s, and the tree every 10 s, without a
  notification. tmux has none for a pane's program or folder changing.
- Each capture is compared with the last one sent. The phone gets the rows that differ,
  and a scroll offset when the screen moved up, so scrolling output costs the new rows and
  not the whole screen. A size change or a switch to the alternate screen is sent whole.
- A phone that joins a pane others already watch first gets the screen they have, then
  the same row updates as everyone.
- A pane is busy until it has printed nothing for 2.5 s.
- A phone whose queue of 256 messages is full has stopped reading; it is dropped and
  reconnects to a fresh state.

When the last phone leaves, the links are kept for 10 s and then closed. With no phone and
no link the hub's loop has no timer running.

If tmux is not running, phones are told so (`"server": false`) and the hub tries to attach
every 3 s. A session can still be started: that one command forks `tmux new-session -d`.

## Wire protocol

### HTTP

| Method | Path | Does |
| --- | --- | --- |
| GET | `/` | the interface |
| GET | `/api/health` | `{ok, version}` |
| POST | `/api/pair` | `{code, label}` to `{token, label}` |
| GET | `/api/ws` | the WebSocket |

`POST /api/upload` takes a file as the request body, its name in `x-name` and the device's
token as `Authorization: Bearer`. Up to 32 MB. It is saved, mode 0600, as
`<state>/uploads/<milliseconds>-<name>`, the name reduced to letters, digits, dot, dash and
underscore, and the answer is `{"path": ...}`. The page then types that path into the open
pane. Nothing removes these files; the folder is the owner's to empty.

The computer's state and two speed tests, each with the device's token as `Authorization:
Bearer`. `GET /api/mac` answers `{"battery": ..., "wifi": ...}` from `pmset -g batt` and
`system_profiler SPAirPortDataType -json`, kept 10 s (the second takes about 1.7 s); the
network's name is left out, as macOS hides it from programs without Location access.
While any phone is connected negi holds a `PreventUserIdleSystemSleep` assertion, so the
Mac does not sleep for idleness under a session or the screen; the lid still sleeps it.
`GET /api/speed/down?bytes=N` sends N bytes that do not compress and `POST /api/speed/up`
says how many bytes arrived, both up to 32 MB, for the page to time the phone's link to the
host. `POST /api/speed/internet` runs `networkQuality -c -M 20` on the host, one run at a
time, the result kept for a minute: down and up in Mbps, responsiveness, base round trip.

`GET /api/screen` is a WebSocket to the host's screen, in one of two ways.

Live video, when the first message is `{"token": ..., "mode": "video", "width": 1280}`.
A device that has not yet proved the Mac's password gets
`{"error": ..., "password": "<account>"}` instead; `POST /api/screen/verify` with
`{"password"}` and the device's bearer key has macOS check it (PAM, `checkpw`, for the
account negi runs as), marks the device, and keeps nothing. Five wrong tries lock that
device out for five minutes.
negi captures the main display with ScreenCaptureKit at that width (at most the display's
own pixels), encodes it with the hardware H.264 encoder (Main profile, real time, no frame
reordering, low-latency rate control, 3 Mbit/s), without the cursor (the page draws its
own at once rather than a round trip late), and answers
`{"ok": true, "video": {"width", "height"}, "input": bool}`. Each binary message after that
is one picture: a flags byte (1 for a keyframe), its time in microseconds as eight bytes
big-endian, then the picture in Annex B, SPS and PPS in front of a keyframe. A picture is
sent only when the screen changed; a keyframe only first, after a picture was dropped, or
when the page sends `{"key": true}`. With four pictures waiting for the socket the next is
dropped, and the ones after it until a keyframe. The page sends text: `{"p": [x, y, mask]}`
moves the pointer in the video's pixels with VNC's button mask (wheel steps as buttons 8
to 64), `{"k": [keysym, down]}` presses or releases an X11 keysym. negi posts them with
CGEvent; `input` says whether macOS lets it (Accessibility). When it may not record the
screen the answer is `{"error": ..., "video": false}`, and the page uses screen sharing.

Screen sharing, otherwise: VNC on `127.0.0.1:5900`. The first message is `{"token": ...}`;
the answer is `{"ok": true}` or `{"error": ...}`, and from then on every binary message is
VNC, carried untouched in both directions. negi adds no login of its own to it beyond the
device's token: the screen sharing server asks for an account's name and password, which
the page passes on and does not keep.

Either way, a device unpaired while it watches is cut off within 15 s.

### WebSocket

JSON text messages. The first message must be `{"t":"hello","token":"..."}` within 5 s.
The token travels in the socket, never in a URL.

Server to phone:

| `t` | Fields | Meaning |
| --- | --- | --- |
| `ready` | `device`, `version` | the token was accepted |
| `bye` | `reason` | closing; `unpaired` means pair again |
| `tree` | `server`, `sessions`, `busy` | everything tmux has; sent on change |
| `screen` | `pane`, `cols`, `rows`, `alt`, `cur`, `lines` | a whole screen |
| `rows` | `pane`, `cur`, `scroll`, `set` | drop `scroll` rows from the top, add as many empty ones at the bottom, then replace each `[index, text]` in `set` |
| `busy` | `pane`, `on` | the pane started or stopped printing |
| `gone` | `pane` | the pane closed |
| `ack` | `id`, `ok`, `error` or data | the answer to a request that carried an `id` |

`cur` is `[column, row, visible]`. Lines carry SGR colour sequences as tmux printed them.

Phone to server:

| `t` | Fields |
| --- | --- |
| `watch` | `pane`, `open` (the pane being looked at, or a preview) |
| `unwatch` | `pane` |
| `keys` | `id`, `pane`, `keys` |
| `text` | `id`, `pane`, `text`, `enter` |
| `history` | `id`, `pane`, `lines`; answers `lines` and `alt`. On the alternate screen `lines` is empty |
| `new-session` | `id`, `name?`, `cwd?` |
| `new-window` | `id`, `session`, `name?`, `cwd?` |
| `rename-session`, `rename-window` | `id`, `session` or `window`, `name` |
| `select-window` | `id`, `window` |
| `kill-session`, `kill-window`, `kill-pane` | `id`, the target |
| `click` | `id`, `pane`, `x`, `y` from 0: a left click there, sent only if the program asked for the mouse; answers `sent` |
| `wheel` | `id`, `pane`, `x`, `y`, `lines` (up when negative): turns of the mouse wheel, sent only if the program asked for the mouse; answers `sent` |
| `fit` | `id`, `pane`, `cols`, `rows`: size the pane's window for this device |
| `unfit` | `id`, `pane`: give the window back to tmux to size |

Requests from one socket run one at a time, in order, on their own task, so a write never
holds back the screen updates going the other way. An ack and a screen update may arrive in
either order.

## Security

negi is remote shell access by design: a paired device can read every pane and type
anything. There is no command allowlist, which would defeat the purpose.

- Binds `127.0.0.1` only.
- Host allowlist: loopback names and the configured tailnet names. Anything else gets 403,
  which is what stops DNS rebinding.
- A request that came through a proxy (any `Tailscale-*` or `X-Forwarded-*` header, or a
  non-loopback Host) must carry `Tailscale-User-Login` equal to a trusted user
  (`--trusted-user`, comma-separated for several). With none configured, only direct loopback requests are served.
- Writes and WebSocket upgrades: `Origin` must equal the `Host` the request came in on. A
  proxied one without `Origin` is refused; only local tools may leave it out.
- Pairing: `negi pair` shows an 8-character code (40 bits), valid 10 minutes, single
  use, dead after 8 wrong guesses. The phone trades it for a 256-bit token. Only SHA-256
  hashes of the code and the token are stored; comparison does not stop at the first
  difference.
- `negi pair` stays until the code is used, then names the device, the tailnet login it
  came from and its browser. Ctrl+C or the 10 minutes running out deletes the code; a
  second `negi pair` replaces it and the first one says so. `--no-wait` prints the code
  and returns, for scripts, leaving it valid for the 10 minutes.
- An open socket re-checks its device every 15 s, so a revoked phone stops seeing panes
  within that long.
- State lives in `~/.local/state/negi` (0700), files 0600. `audit.log` gets one line per
  write: time, device, kind, target, size. Never the text.
- Limits: 256 kB per message, 64 kB per text, 64 watched panes and 64 queued requests per
  socket, 32 paired devices.

Not verified yet: that the tailnet proxy sets the headers the admission rule relies on and
strips client-sent copies. That check belongs to the installer milestone, before the server
is ever published to a tailnet.

## Milestones

| | What | State |
| --- | --- | --- |
| M1 | `proto`, `link`, `tmux`, `mux`, CLI (`ls`, `screen`, `keys`, `type`) | done: unit tests plus 12 live tests |
| M2 | `screen`, `hub`, `store`, `server`, CLI (`serve`, `pair`, `devices`, `revoke`) | done: 8 hub tests and 5 server tests over real sockets; 3 MB resident and 0.0% CPU with no phone |
| M3 | The phone interface, embedded in the binary | done in headless Chrome at 390 px: pairing, opening a pane, typing, keys, rename, history and closing a session, 12 checks. Empty, lost-connection and reduced-motion states, contrast and keyboard-only use were checked on the first, hand-written version and not yet again on this one. Not yet opened on a real phone |
| M4 | `install`, `uninstall`, `doctor`: service plus tailnet proxy, and the header check above | not started |
| M5 | Notifications when a busy pane goes quiet | not started |

## The interface

A single-page app in `web/` (Vite, React, TypeScript, Tailwind, shadcn/ui, TanStack Router,
Query, Form and Virtual, zustand, react-use-websocket). Its build is embedded in the
binary. Any path that is not `/api/...` or a built file gets the page, and the page's
router takes it from there: `/` is the session list, `/pane/3` is pane `%3`, `/pair` is
pairing.

- The page keeps a socket only while it is visible. A hidden page closes it, so the Mac
  holds no control client for a phone that is in a pocket.
- At home the page watches one pane per session as a preview. In a pane it watches that
  pane as open.
- A request made while disconnected fails at once. It is never queued and replayed after
  a reconnect, when the screen it was meant for may be gone.
- The terminal is painted outside React, row by row, from the server's row updates. A
  pane's loaded history is virtualised.
- A pane's text is sized so its columns fill the width, down to 9 px; below that the
  terminal scrolls sideways. The size can be set from 50% to 300% of that fit, and is kept
  in the browser.
- Every request that changes tmux other than typing and keys (rename, new session, new
  window, the three closes) is sent on the second press of its control. The first press
  arms it for 3 s. This is a guard against a slip, in the page only; the server does not
  ask twice.
- `ready` carries the host's system (`os`, as Rust names it). The key row uses it to
  choose between a Mac's keys and a PC's. Either way the server gets tmux key names:
  the page turns command and shift combinations into them before sending.
- `ready` carries `build`, a hash of the page the server holds. A page that was loaded
  under another build reloads itself, so a restarted server is never driven by an old page.
- With a hardware keyboard and the terminal focused, keys go straight to the pane.
- A pane is shown one of two ways, chosen in its sheet and kept in the browser. As is:
  the screen as the host has it. Fit: the page sends `fit` with the columns and rows its
  box holds at 13 px; the server runs `resize-window -x -y` on the pane's window, which
  also sets `window-size manual` on it, so every other client sees it that small. `unfit`
  runs `resize-window -A` and unsets `window-size`. The server keeps the panes each socket
  has fitted and gives them all back when the socket ends, however it ends.
- A pane's earlier output (1000 lines) is fetched as the pane opens and sits above the
  screen, out of sight until scrolled to. After a fit it is fetched again, because tmux
  rewraps it to the new width.
- A pane that tmux no longer lists returns the phone to the session list with a notice.
  A pane just created is not listed yet, so only a pane that was listed and then went
  missing counts.
- The content policy allows scripts from the server only. Styles may be inline, because
  the animation and sheet libraries set them on elements as they move.

## Known gaps

- The interface's script is 960 kB (290 kB compressed) in one file. It is not split, and
  the icon and animation libraries have not been trimmed.
- The interface has only been run in Chrome. Safari on a phone, the primary target, is
  untested: the rounded system face, view transitions and the on-screen keyboard's effect
  on the layout all need a look there.
- Wide characters (CJK, some emoji) take two columns in tmux and are not measured by the
  page, so the cursor can sit off by a column on such a row.

- No test for revocation closing an open socket; the check runs every 15 s and the tests do
  not wait that long.
- `select-window` exists in the protocol but changes what a real terminal shows. Whether
  the interface should use it is undecided.
- The 150 ms pause before Enter is unmeasured.
- Only tmux 3.8 on macOS has been run.
