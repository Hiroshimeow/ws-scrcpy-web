// Minimal file logger for the Rust launcher.
//
// Release builds use `windows_subsystem = "windows"` and have no attached
// console, so stderr/stdout from `eprintln!` is invisible. We always also
// write to `<exe_dir>/launcher.log` so failures during install/update/run
// can be diagnosed.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

fn log_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join("launcher.log"))
}

fn append(prefix: &str, msg: &str) {
    if let Some(path) = log_path() {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "[{prefix}] {msg}");
        }
    }
    eprintln!("[{prefix}] {msg}");
}

pub fn info(msg: &str) {
    append("INFO", msg);
}

pub fn error(msg: &str) {
    append("ERROR", msg);
}
