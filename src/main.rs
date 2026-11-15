use std::io::IsTerminal;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use clap::builder::styling::{AnsiColor, Effects, Styles};
use clap::{Parser, Subcommand};
use console::style;

use negi::hub::{Hub, Timing};
use negi::server::{self, App, Config};
use negi::store::{Device, Pairing, Store};
use negi::tmux::mux;
use negi::tmux::{Socket, Tmux};

const STYLES: Styles = Styles::styled()
    .header(AnsiColor::Green.on_default().effects(Effects::BOLD))
    .usage(AnsiColor::Green.on_default().effects(Effects::BOLD))
    .literal(AnsiColor::Cyan.on_default().effects(Effects::BOLD))
    .placeholder(AnsiColor::BrightBlack.on_default())
    .valid(AnsiColor::Cyan.on_default())
    .invalid(AnsiColor::Yellow.on_default())
    .error(AnsiColor::Red.on_default().effects(Effects::BOLD));

const HELP: &str = "\
{about}

{usage-heading} {usage}

{all-args}{after-help}";

/// tmux on your phone
#[derive(Parser)]
#[command(name = "negi", version = server::VERSION, styles = STYLES, help_template = HELP, disable_help_subcommand = true)]
#[command(after_help = "Pair a phone: start `negi serve`, open it on the phone, then run `negi pair`.")]
struct Cli {
    /// tmux socket name, as tmux -L
    #[arg(short = 'L', global = true, value_name = "NAME", conflicts_with = "socket_path")]
    socket_name: Option<String>,
    /// tmux socket path, as tmux -S
    #[arg(short = 'S', global = true, value_name = "PATH")]
    socket_path: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the server on 127.0.0.1
    #[command(display_order = 1)]
    Serve {
        #[arg(long, env = "NEGI_PORT", default_value_t = 8791)]
        port: u16,
        /// A name the server answers to besides localhost; by default this machine's tailnet name
        #[arg(long = "host", value_name = "NAME", env = "NEGI_HOSTS", value_delimiter = ',')]
        hosts: Vec<String>,
        /// The tailnet login allowed in through the proxy; by default this machine's owner
        #[arg(long, value_name = "LOGIN", env = "NEGI_TRUSTED_USER")]
        trusted_user: Option<String>,
    },
    /// Put negi on your tailnet with `tailscale serve`, and show its address
    #[command(display_order = 2)]
    Tailnet {
        /// The port `negi serve` listens on
        #[arg(long, env = "NEGI_PORT", default_value_t = 8791)]
        port: u16,
        /// Stop serving it on the tailnet
        #[arg(long)]
        off: bool,
    },
    /// Pair a phone: show a one-time code and wait until it is used
    #[command(display_order = 3)]
    Pair {
        /// Print the code and return at once; it stays valid for 10 minutes
        #[arg(long)]
        no_wait: bool,
    },
    /// List paired devices
    #[command(display_order = 4)]
    Devices,
    /// Unpair a device; asks which one when none is named
    #[command(display_order = 5)]
    Revoke {
        /// Its id (or the start of it) or its name
        device: Option<String>,
        /// Do not ask before unpairing
        #[arg(short, long)]
        yes: bool,
    },
    /// Sessions, windows and panes
    #[command(display_order = 10)]
    Ls,
    /// Print a pane's screen
    #[command(display_order = 11)]
    Screen {
        pane: String,
        /// Lines of history to print above it
        #[arg(value_name = "LINES")]
        history: Option<u32>,
    },
    /// Press keys in a pane: Enter, Escape, C-c, Up, ...
    #[command(display_order = 12)]
    Keys {
        pane: String,
        #[arg(required = true)]
        keys: Vec<String>,
    },
    /// Type text into a pane
    #[command(display_order = 13)]
    Type {
        pane: String,
        text: String,
        /// Press Enter after it
        #[arg(long)]
        enter: bool,
    },
    #[command(hide = true)]
    Version,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("a runtime starts");
    match runtime.block_on(run(cli)) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("{} {message}", style("negi:").red().bold());
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<ExitCode, String> {
    let socket = match (cli.socket_name, cli.socket_path) {
        (Some(name), _) => Socket::Name(name),
        (_, Some(path)) => Socket::Path(path),
        _ => Socket::Default,
    };
    let Some(command) = cli.command else {
        use clap::CommandFactory;
        Cli::command().print_help().map_err(|e| e.to_string())?;
        return Ok(ExitCode::SUCCESS);
    };
    match command {
        Command::Serve { port, hosts, trusted_user } => {
            let mut hosts: Vec<String> = hosts.into_iter().map(|h| h.trim().to_owned()).filter(|h| !h.is_empty()).collect();
            let mut trusted_user = trusted_user;
            // Unless told otherwise, answer to this machine's tailnet name and let its owner in,
            // read fresh at every start, so a renamed machine needs no new flags.
            if let Ok(me) = negi::tailnet::me().await {
                if hosts.is_empty() {
                    hosts.push(me.name.clone());
                }
                trusted_user.get_or_insert(me.login.clone());
                match negi::tailnet::serving(&me, port).await {
                    Ok(s) if s.here => eprintln!("negi: on your tailnet at https://{}", me.name),
                    _ => eprintln!("negi: not on your tailnet yet; run `negi tailnet --port {port}`"),
                }
            }
            serve(socket, port, Config { hosts, trusted_user }).await?;
        }
        Command::Tailnet { port, off } => return tailnet(port, off).await,
        Command::Pair { no_wait } => return pair(no_wait).await,
        Command::Devices => devices()?,
        Command::Revoke { device, yes } => return revoke(device, yes),
        Command::Ls => ls(socket).await?,
        Command::Screen { pane, history } => {
            let link = open(socket).await?;
            if let Some(count) = history {
                for line in mux::history(&link, &pane, count).await.map_err(|e| e.to_string())? {
                    println!("{line}");
                }
            }
            for line in mux::screen(&link, &pane).await.map_err(|e| e.to_string())?.lines {
                println!("{line}");
            }
        }
        Command::Keys { pane, keys } => {
            let link = open(socket).await?;
            mux::keys(&link, &pane, &keys).await.map_err(|e| e.to_string())?;
        }
        Command::Type { pane, text, enter } => {
            let link = open(socket).await?;
            mux::text_in(&link, &pane, &text, enter).await.map_err(|e| e.to_string())?;
        }
        Command::Version => println!("negi {}", server::VERSION),
    }
    Ok(ExitCode::SUCCESS)
}

/// Shows a code and stays until it has been used, has run out, or Ctrl+C takes it back. A
/// code is never left behind valid for nobody to watch.
async fn pair(no_wait: bool) -> Result<ExitCode, String> {
    let store = store()?;
    let code = store.start_pairing().map_err(|e| e.to_string())?;
    let shown = format!("{}-{}", &code[..4], &code[4..]);
    if no_wait {
        println!("{shown}");
        return Ok(ExitCode::SUCCESS);
    }
    let fancy = std::io::stderr().is_terminal();
    let io = |e: std::io::Error| e.to_string();
    let spinner = cliclack::spinner();
    if fancy {
        cliclack::intro(style(" negi pair ").on_green().black().bold()).map_err(io)?;
        // Written plainly, so that copying it pastes as it reads.
        cliclack::note(
            "Enter this on the phone",
            format!(
                "{}\n\n{}",
                style(&shown).cyan().bold(),
                style("It works once. Ctrl+C takes it back.").dim()
            ),
        )
        .map_err(io)?;
        spinner.start("Waiting for a phone");
    } else {
        println!("{shown}");
        eprintln!("Waiting for a phone. Ctrl+C takes the code back.");
    }
    // The terminal would print ^C over the spinner; nothing typed here is wanted anyway.
    let _quiet = fancy.then(Quiet::new).flatten();

    let mut tick = tokio::time::interval(Duration::from_millis(250));
    let interrupted = tokio::signal::ctrl_c();
    tokio::pin!(interrupted);
    loop {
        tokio::select! {
            _ = &mut interrupted => {
                store.cancel_pairing(&code).map_err(|e| e.to_string())?;
                if fancy {
                    spinner.cancel("Cancelled");
                    cliclack::outro_cancel("The code no longer works.").map_err(io)?;
                } else {
                    eprintln!("Cancelled. The code no longer works.");
                }
                return Ok(ExitCode::from(130));
            }
            _ = tick.tick() => {}
        }
        let failed = match store.pairing(&code) {
            Pairing::Waiting { expires, tries } => {
                if fancy {
                    let left = expires.saturating_sub(now());
                    let mut message = format!("Waiting for a phone  {}", style(format!("{}:{:02} left", left / 60, left % 60)).dim());
                    if tries > 0 {
                        message += &style(format!("  {tries} wrong {}", if tries == 1 { "try" } else { "tries" })).yellow().to_string();
                    }
                    spinner.set_message(message);
                }
                continue;
            }
            Pairing::Paired(device) => {
                if fancy {
                    spinner.stop(format!("Paired {}", style(&device.label).cyan().bold()));
                    cliclack::outro(format!("{}\n   {}", from(&device), style(format!("`negi revoke {}` unpairs it", device.id)).dim())).map_err(io)?;
                } else {
                    println!("Paired {} ({}), {}", device.label, device.id, from(&device));
                }
                return Ok(ExitCode::SUCCESS);
            }
            Pairing::Replaced => "Another `negi pair` replaced this code.",
            Pairing::Expired => "The code ran out. Run `negi pair` again.",
            Pairing::UsedUp => "Too many wrong tries; the code was dropped. Run `negi pair` again.",
        };
        if fancy {
            spinner.error(failed);
            cliclack::outro_cancel("Not paired.").map_err(io)?;
        } else {
            eprintln!("{failed}");
        }
        return Ok(ExitCode::FAILURE);
    }
}

/// Keeps the terminal from echoing keys while it lives; puts it back as it was after.
struct Quiet(libc::termios);

impl Quiet {
    fn new() -> Option<Self> {
        let mut was = unsafe { std::mem::zeroed::<libc::termios>() };
        // SAFETY: plain termios calls on stdin with a struct of the right type.
        unsafe {
            if libc::tcgetattr(libc::STDIN_FILENO, &mut was) != 0 {
                return None;
            }
            let mut quiet = was;
            quiet.c_lflag &= !(libc::ECHO | libc::ECHOCTL);
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &quiet);
        }
        Some(Self(was))
    }
}

impl Drop for Quiet {
    fn drop(&mut self) {
        // SAFETY: restores the settings read in `new`.
        unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.0) };
    }
}

/// Puts negi on the tailnet, or takes it off, and says where it can be reached.
async fn tailnet(port: u16, off: bool) -> Result<ExitCode, String> {
    let io = |e: std::io::Error| e.to_string();
    let fancy = std::io::stderr().is_terminal();
    let me = negi::tailnet::me().await.map_err(|e| format!("{e}. Install Tailscale and sign in first."))?;
    if fancy {
        cliclack::intro(style(" negi tailnet ").on_green().black().bold()).map_err(io)?;
        cliclack::log::info(format!("{}  {}", style(&me.name).bold(), style(&me.login).dim())).map_err(io)?;
    }
    let spinner = cliclack::spinner();
    if off {
        if fancy {
            spinner.start("Taking negi off the tailnet");
        }
        negi::tailnet::unshare().await?;
        if fancy {
            spinner.stop("Off the tailnet");
            cliclack::outro("Only this computer reaches negi now.").map_err(io)?;
        } else {
            println!("negi is off the tailnet");
        }
        return Ok(ExitCode::SUCCESS);
    }
    let before = negi::tailnet::serving(&me, port).await?;
    let url = format!("https://{}", me.name);
    if before.here && before.stale.is_empty() {
        if fancy {
            cliclack::outro(format!("Already on your tailnet: {}", style(&url).cyan().bold())).map_err(io)?;
        } else {
            println!("{url}");
        }
        return Ok(ExitCode::SUCCESS);
    }
    if fancy {
        spinner.start(format!("Serving port {port} on your tailnet"));
    }
    negi::tailnet::share(&me, port).await?;
    let after = negi::tailnet::serving(&me, port).await?;
    if !after.here {
        if fancy {
            spinner.error("Tailscale did not take it");
        }
        return Err("tailscale serve did not take the rule; try `tailscale serve status`".to_owned());
    }
    if fancy {
        spinner.stop(format!("On your tailnet, for {} only", me.login));
        if !after.stale.is_empty() {
            cliclack::log::warning(format!("Still served under an old name: {}. Other sites are served too, so it was left alone.", after.stale.join(", "))).map_err(io)?;
        }
        cliclack::outro(format!(
            "Open {} on your phone, then run {}.\n   {}",
            style(&url).cyan().bold(),
            style("negi pair").cyan().bold(),
            style(format!("`negi serve --port {port}` must be running; it answers to this name by itself.")).dim()
        ))
        .map_err(io)?;
    } else {
        println!("{url}");
    }
    Ok(ExitCode::SUCCESS)
}

/// "rifuki@github · Safari on iPhone"
fn from(device: &Device) -> String {
    [device.via.as_str(), device.agent.as_str()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

fn devices() -> Result<(), String> {
    let devices = store()?.devices();
    if devices.is_empty() {
        println!("No devices are paired. Run {}.", style("negi pair").cyan().bold());
        return Ok(());
    }
    let width = devices.iter().map(|d| d.label.chars().count()).max().unwrap_or(0);
    for d in devices {
        let pad = " ".repeat(width - d.label.chars().count());
        let mut about = vec![ago(d.created)];
        if !d.via.is_empty() || !d.agent.is_empty() {
            about.insert(0, from(&d));
        }
        println!("{}{pad}  {}  {}", style(&d.label).bold(), style(&d.id).cyan(), style(about.join(" · ")).dim());
    }
    Ok(())
}

fn revoke(wanted: Option<String>, yes: bool) -> Result<ExitCode, String> {
    let store = store()?;
    let devices = store.devices();
    let interactive = std::io::stdin().is_terminal() && std::io::stderr().is_terminal();
    let cancelled = |e: &std::io::Error| e.kind() == std::io::ErrorKind::Interrupted;
    let device = match wanted {
        Some(wanted) => {
            let found: Vec<&Device> = devices
                .iter()
                .filter(|d| d.id.starts_with(&wanted) || d.label.eq_ignore_ascii_case(&wanted))
                .collect();
            match found.as_slice() {
                [one] => (*one).clone(),
                [] => return Err(format!("no device matches {wanted:?}; `negi devices` lists them")),
                _ => return Err(format!("{wanted:?} matches {} devices; give more of the id", found.len())),
            }
        }
        None if devices.is_empty() => {
            println!("No devices are paired.");
            return Ok(ExitCode::SUCCESS);
        }
        None if !interactive => return Err("name a device: negi revoke <id>".to_owned()),
        None => {
            cliclack::intro(style(" negi revoke ").on_red().white().bold()).map_err(|e| e.to_string())?;
            let mut select = cliclack::select("Which device?");
            for d in &devices {
                select = select.item(d.id.clone(), &d.label, [d.id.clone(), from(d)].join("  ").trim_end());
            }
            match select.interact() {
                Ok(id) => devices.iter().find(|d| d.id == id).cloned().expect("chosen from the list"),
                Err(e) if cancelled(&e) => {
                    cliclack::outro_cancel("Nothing was unpaired.").map_err(|e| e.to_string())?;
                    return Ok(ExitCode::from(130));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    };
    if !yes && interactive {
        let asked = cliclack::confirm(format!("Unpair {}? It will have to pair again.", style(&device.label).bold()))
            .initial_value(false)
            .interact();
        match asked {
            Ok(true) => {}
            Ok(false) => {
                cliclack::outro_cancel("Nothing was unpaired.").map_err(|e| e.to_string())?;
                return Ok(ExitCode::SUCCESS);
            }
            Err(e) if cancelled(&e) => {
                cliclack::outro_cancel("Nothing was unpaired.").map_err(|e| e.to_string())?;
                return Ok(ExitCode::from(130));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    store.revoke(&device.id).map_err(|e| e.to_string())?;
    println!("{} {} ({}) is unpaired.", style("✓").green().bold(), style(&device.label).bold(), device.id);
    Ok(ExitCode::SUCCESS)
}

async fn ls(socket: Socket) -> Result<(), String> {
    let link = open(socket).await?;
    for s in mux::tree(&link).await.map_err(|e| e.to_string())? {
        let attached = if s.attached { style(" attached").green().to_string() } else { String::new() };
        println!("{} {}{attached}", style(&s.name).bold(), style(&s.id).dim());
        for w in s.windows {
            let marker = if w.active { style("●").green() } else { style("○").dim() };
            println!("  {marker} {}:{} {}", w.index, w.name, style(&w.id).dim());
            for p in w.panes {
                println!("      {} {} {}x{} {}", style(&p.id).cyan(), p.command, p.cols, p.rows, style(&p.path).dim());
            }
        }
    }
    Ok(())
}

async fn open(socket: Socket) -> Result<negi::tmux::link::Link, String> {
    let tmux = Tmux::find(socket)?;
    mux::open(&tmux).await.map_err(|e| match e {
        negi::tmux::link::Error::Closed(why) if why.is_empty() => "tmux is not running".to_owned(),
        e => e.to_string(),
    })
}

fn store() -> Result<Store, String> {
    let dir = Store::default_dir().ok_or("no home folder; set NEGI_STATE")?;
    Store::open(dir).map_err(|e| format!("state folder: {e}"))
}

async fn serve(socket: Socket, port: u16, config: Config) -> Result<(), String> {
    let tmux = Tmux::find(socket)?;
    let app = Arc::new(App {
        hub: Hub::start(tmux.clone(), Timing::default()),
        store: store()?,
        tmux,
        config,
    });
    tokio::select! {
        served = server::serve(app, port) => served.map_err(|e| e.to_string()),
        _ = stop() => Ok(()),
    }
}

/// Resolves on Ctrl+C or when launchd asks the service to stop.
async fn stop() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate()).expect("a signal handler installs");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// "paired 3 days ago"
fn ago(at: u64) -> String {
    let secs = now().saturating_sub(at);
    let (n, unit) = match secs {
        0..60 => return "paired just now".to_owned(),
        60..3600 => (secs / 60, "minute"),
        3600..86400 => (secs / 3600, "hour"),
        _ => (secs / 86400, "day"),
    };
    format!("paired {n} {unit}{} ago", if n == 1 { "" } else { "s" })
}
