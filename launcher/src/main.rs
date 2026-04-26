#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod log;
mod paths;
mod spawn;
mod supervisor;

fn main() {
    log::info(&format!(
        "ws-scrcpy-web-launcher v{} starting",
        env!("CARGO_PKG_VERSION")
    ));

    let exit_code = match supervisor::run() {
        Ok(code) => code,
        Err(e) => {
            log::error(&format!("launcher failed: {e:#}"));
            1
        }
    };

    log::info(&format!("ws-scrcpy-web-launcher exiting with code {exit_code}"));
    std::process::exit(exit_code);
}
