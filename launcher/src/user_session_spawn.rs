// Cross-session spawn helper for the v0.1.8 uninstall flow (Path A).
//
// The Windows service runs as Local System in session 0. The user's
// browser runs in their interactive session (session 1+). When the user
// clicks "uninstall service" in the service-hosted UI, the Node process
// handling that click is in session 0 — child processes it spawns
// inherit session 0 too, so a launcher spawned that way would be
// invisible to the user's interactive session.
//
// To spawn a launcher in the user's session FROM a service we use the
// WTS (Windows Terminal Services) APIs:
//   1. WTSGetActiveConsoleSessionId   — find which session the
//      interactive user is using
//   2. WTSQueryUserToken               — get a primary token for that
//      session's user (requires SE_TCB_NAME, which Local System has)
//   3. CreateProcessAsUserW            — spawn the new process with
//      that token, so it lands in the user's session with their token
//
// This module is invoked via the launcher's --elevate-and-run dispatch
// (new command: `spawn-user-launcher`). The Node service-instance
// triggers it; the Rust handler does the WTS dance and writes a result
// JSON the Node side reads back.
//
// IMPORTANT: This is admin-only. The caller (Node service process) is
// running as Local System, which has SE_TCB_NAME by default. If invoked
// from a non-Local-System context, WTSQueryUserToken returns
// ERROR_PRIVILEGE_NOT_HELD.

#![cfg(windows)]

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::log;

/// Args for the `spawn-user-launcher` command.
#[derive(Debug, Deserialize)]
pub struct SpawnUserLauncherArgs {
    /// Absolute path to the launcher exe to spawn in the user's
    /// session. Caller resolves this to the same launcher binary
    /// they're running from (we use process.cwd() / launcher.exe).
    pub launcher_path: String,
    /// Optional argv to pass to the launcher (post-exe). Currently
    /// unused by the launcher's normal startup path; reserved for
    /// future "auto-resume" semantics.
    #[serde(default)]
    pub launcher_args: Vec<String>,
}

#[derive(Debug, Serialize, Default)]
pub struct SpawnResult {
    pub ok: bool,
    pub pid: u32,
    pub session_id: u32,
    pub error_message: Option<String>,
}

pub fn spawn_in_active_user_session(args: &SpawnUserLauncherArgs) -> SpawnResult {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Environment::{
        CreateEnvironmentBlock, DestroyEnvironmentBlock,
    };
    use windows::Win32::System::RemoteDesktop::{
        WTSGetActiveConsoleSessionId, WTSQueryUserToken,
    };
    use windows::Win32::System::Threading::{
        CreateProcessAsUserW, CREATE_UNICODE_ENVIRONMENT, NORMAL_PRIORITY_CLASS,
        PROCESS_INFORMATION, STARTUPINFOW,
    };
    use windows::core::PWSTR;

    log::info(&format!(
        "spawn-user-launcher: target={} args={:?}",
        args.launcher_path, args.launcher_args
    ));

    if !Path::new(&args.launcher_path).exists() {
        return SpawnResult {
            ok: false,
            pid: 0,
            session_id: 0,
            error_message: Some(format!("launcher not found: {}", args.launcher_path)),
        };
    }

    unsafe {
        let session_id = WTSGetActiveConsoleSessionId();
        if session_id == 0xFFFF_FFFF {
            return SpawnResult {
                ok: false,
                pid: 0,
                session_id: 0,
                error_message: Some(
                    "no active console session (WTSGetActiveConsoleSessionId returned -1)"
                        .to_string(),
                ),
            };
        }

        let mut user_token: HANDLE = HANDLE::default();
        if let Err(e) = WTSQueryUserToken(session_id, &mut user_token) {
            return SpawnResult {
                ok: false,
                pid: 0,
                session_id,
                error_message: Some(format!(
                    "WTSQueryUserToken failed (session {session_id}): {e:?}. Caller must be Local System with SE_TCB_NAME."
                )),
            };
        }

        // Build the command line: "<launcher_path>" arg1 arg2 ...
        // CreateProcessAsUserW takes the command line as a writable
        // PWSTR (the API actually mutates it during parsing — Win32
        // history). We allocate an owned UTF-16 buffer and pass a
        // pointer.
        let mut cmd_line: Vec<u16> = OsStr::new(&format!("\"{}\"", args.launcher_path))
            .encode_wide()
            .collect();
        for a in &args.launcher_args {
            cmd_line.push(' ' as u16);
            for w in OsStr::new(a).encode_wide() {
                cmd_line.push(w);
            }
        }
        cmd_line.push(0); // null-terminator

        let mut si = STARTUPINFOW::default();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut pi = PROCESS_INFORMATION::default();

        let cwd: Option<&str> = Path::new(&args.launcher_path)
            .parent()
            .and_then(|p| p.to_str());
        let cwd_wide: Option<Vec<u16>> = cwd.map(|s| {
            OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
        });
        // windows-rs 0.58 wants a concrete PCWSTR for lpCurrentDirectory,
        // not Option<PCWSTR>. PCWSTR::null() is the documented "no cwd"
        // sentinel — CreateProcessAsUserW will then use the parent's cwd.
        let cwd_pcwstr = match &cwd_wide {
            Some(v) => windows::core::PCWSTR::from_raw(v.as_ptr()),
            None => windows::core::PCWSTR::null(),
        };

        // v0.1.9: build the user's environment block instead of
        // inheriting our (Local System) env. Without this, the new
        // process gets %APPDATA% / %LOCALAPPDATA% / %USERPROFILE%
        // pointing at C:\Windows\system32\config\systemprofile\... —
        // Velopack init reads %APPDATA% for its update cache and
        // various launcher startup paths break with Local System's
        // environment. The v0.1.8 uninstall handoff would silently
        // fail at this stage: the launcher spawned, started up, but
        // exited before reaching its supervisor's HTTP listen because
        // Velopack or path resolution broke.
        let mut env_block: *mut std::ffi::c_void = std::ptr::null_mut();
        let env_built = CreateEnvironmentBlock(&mut env_block, user_token, false).is_ok();

        let create = CreateProcessAsUserW(
            user_token,
            None, // lpApplicationName — we put the exe in lpCommandLine instead
            PWSTR::from_raw(cmd_line.as_mut_ptr()),
            None, // lpProcessAttributes
            None, // lpThreadAttributes
            false,
            // CREATE_UNICODE_ENVIRONMENT is mandatory when
            // lpEnvironment is non-null AND came from
            // CreateEnvironmentBlock (which always returns UTF-16).
            // Without it, CreateProcessAsUserW would interpret the
            // block as ANSI and produce garbage env vars.
            NORMAL_PRIORITY_CLASS | CREATE_UNICODE_ENVIRONMENT,
            if env_built { Some(env_block) } else { None },
            cwd_pcwstr,
            &si,
            &mut pi,
        );

        if env_built {
            let _ = DestroyEnvironmentBlock(env_block);
        }
        let _ = CloseHandle(user_token);

        if let Err(e) = create {
            return SpawnResult {
                ok: false,
                pid: 0,
                session_id,
                error_message: Some(format!("CreateProcessAsUserW failed: {e:?}")),
            };
        }

        let pid = pi.dwProcessId;
        let _ = CloseHandle(pi.hProcess);
        let _ = CloseHandle(pi.hThread);

        log::info(&format!(
            "spawn-user-launcher: spawned pid {pid} in session {session_id}"
        ));

        SpawnResult {
            ok: true,
            pid,
            session_id,
            error_message: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_fails_for_nonexistent_launcher_path() {
        let args = SpawnUserLauncherArgs {
            launcher_path: r"C:\definitely\does\not\exist\launcher.exe".to_string(),
            launcher_args: vec![],
        };
        let r = spawn_in_active_user_session(&args);
        assert!(!r.ok);
        assert!(r.error_message.unwrap().contains("launcher not found"));
    }
}
