//! Smoke test: launcher --print-active-session writes a single u32 to
//! stdout and exits 0. We can't assert a specific session value (depends
//! on the test runner's environment), but we can assert the format.

use std::process::Command;

#[test]
fn print_active_session_outputs_a_number() {
    let exe = env!("CARGO_BIN_EXE_ws-scrcpy-web-launcher");
    let out = Command::new(exe)
        .arg("--print-active-session")
        .output()
        .expect("spawn launcher");
    assert!(out.status.success(), "launcher exited non-zero: {:?}", out);
    let stdout = String::from_utf8(out.stdout).expect("utf8 stdout");
    let trimmed = stdout.trim();
    assert_eq!(
        stdout.lines().count(),
        1,
        "expected exactly one line of stdout, got: {:?}",
        stdout
    );
    let parsed: u32 = trimmed.parse().expect("session id parses as u32");
    // Sanity: session 0 (LocalSystem) or 1+ (interactive). -1 (0xFFFFFFFF) means
    // no active console; that's a valid degraded state we want to flag separately.
    assert_ne!(parsed, u32::MAX, "expected real session id, got -1 sentinel");
}
