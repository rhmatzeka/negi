# Development

## How it talks to tmux

negi speaks tmux's control mode (`tmux -C`, see CONTROL MODE in `man tmux`). While a
phone is connected it keeps one control client attached to each session:

- Commands go in on the client's stdin and replies come back on its stdout. Nothing forks
  per keystroke or per screen.
- tmux says which pane wrote and when a window or session changed, so negi reads a
  screen only after it changed, and sends the phone the rows that differ.
- With no phone connected there is no control client and the process does nothing.

Measured on an M2 MacBook Air, release build, no phone connected: 3 MB resident and 0.0%
CPU.

## Build

The interface is a Vite app in `web/`; its build is embedded in the binary.

Building needs Swift (the Command Line Tools have it): the screen capture crate compiles
a small Swift bridge, and `build.rs` points the linker at Swift's libraries.

```sh
pnpm --dir web install
pnpm --dir web build          # writes web/dist
cargo build --release         # embeds web/dist
```

`cargo build` alone also works: without `web/dist` it embeds a placeholder page that says
how to build the real one.

## Try it

```sh
./target/release/negi ls                       # sessions, windows, panes
./target/release/negi screen %3                # a pane's screen
./target/release/negi screen %3 200            # with 200 lines of history above it
./target/release/negi type %3 'echo hi' --enter
./target/release/negi keys %3 C-c
./target/release/negi -L other ls              # another tmux server

./target/release/negi serve                    # then open http://127.0.0.1:3939
./target/release/negi tailnet                  # serve it on your tailnet, print its https address
./target/release/negi pair                     # a one-time code; waits until it is used
./target/release/negi devices
./target/release/negi revoke                   # asks which device, then asks again
```

With Tailscale signed in, `negi serve` answers to this machine's tailnet name and lets its
owner in, both read from Tailscale at every start, so a renamed machine needs no flags:
restart it and run `negi tailnet` again. `--host` and `--trusted-user` still override them.

Panes, windows and sessions are named by tmux's own ids (`%3`, `@1`, `$0`), which
`negi ls` prints.

To work on the interface, run `negi serve` and, beside it, `pnpm --dir web dev`: Vite
serves the page with hot reload and proxies `/api` to the running server.

To look at the interface with no Mac and no pairing, open the dev server with `?demo`:
`http://127.0.0.1:5173/?demo` shows a full, clickable app on sample data, and
`?demo=empty`, `?demo=connecting`, `?demo=unreachable` and `?demo=lost` show the other
states. Sample data exists in development builds only.

## The interface's stack

| For | Uses |
| --- | --- |
| Build, language | Vite, TypeScript, React |
| Styling, components | Tailwind CSS, shadcn/ui on Radix, vaul for sheets, sonner for toasts |
| Routes | TanStack Router |
| Server calls | TanStack Query mutations |
| Forms | TanStack Form, validated with zod |
| State | zustand, persisted for the device key and the display choices |
| The socket | react-use-websocket |
| Long lists | TanStack Virtual, for a pane's history |
| Terminal colour | Anser |
| Motion, icons | GSAP (with Flip), Phosphor |
| The Mac's screen | WebCodecs `VideoDecoder` for live video; noVNC for screen sharing |
| Installing as an app | vite-plugin-pwa (Workbox) |

## Tests

```sh
cargo test
```

`NEGI_NO_VIDEO=1` makes the server refuse live video, as a Mac without Screen Recording
does, and `NEGI_VNC_PORT` points screen sharing at a stand-in: together they check the
page's fallback without changing any setting.

macOS's capture service tells clients apart by their executable's path. Two negi servers
started from the same binary, one of which has captured, leave the other's capture hanging
at start; run a second server for tests from a copy of the binary.

The live tests start their own tmux servers on private sockets with `-f /dev/null`, so they
never touch your sessions, your tmux.conf or its plugins. They need tmux installed.

## Checks on GitHub

Every push and pull request runs `CI` (web lint and build, clippy with warnings as errors,
the tests, on Apple silicon) and `Security`: `cargo deny check` against `deny.toml`
(RustSec advisories, licences, crates.io only), `pnpm audit` failing on high and critical,
and CodeQL on the Rust, the TypeScript and the workflows themselves. Security also runs
daily. Dependabot opens weekly pull requests for Rust crates, web packages and the
workflows' actions, which are pinned to commit SHAs.

## Releasing

Bump `version` in `Cargo.toml` and `packaging/npm/package.json` and push to main. While the
repository variable `AUTO_RELEASE` is `true`, the `Release` workflow sees a version with no
tag yet and releases it, with the commits since the last tag as the notes. A push that does
not change the version releases nothing. With `AUTO_RELEASE` off, push an annotated tag
instead (`git tag -a v0.2.3 -F notes.md && git push origin v0.2.3`), whose message becomes
the notes.

The workflow builds on GitHub's Apple silicon runner with `scripts/release.sh`, attests the
tarball's provenance (`gh attestation verify <tarball> -R rifuki/negi`), publishes the
GitHub release, then each registry that is switched on:

| Registry | Switch | Set up once |
| --- | --- | --- |
| crates.io | `PUBLISH_CRATES` = `true` | Trusted publisher on crates.io for `negi`: `rifuki/negi`, `release.yml`. |
| npm | `PUBLISH_NPM` = `true` | `npm trust github @rifuki/negi --file release.yml --repo rifuki/negi --allow-publish` |
| Homebrew | the secret `HOMEBREW_TAP_KEY` | A deploy key with write access on `rifuki/homebrew-tap`; its private half is the secret. |

`sh scripts/release.sh` still builds the same files locally and publishes nothing.
