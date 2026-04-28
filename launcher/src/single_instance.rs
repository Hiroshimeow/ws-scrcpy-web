// Single-instance guard for the launcher.
//
// Without this guard, double-clicking the launcher (or running it twice
// from any source) would spawn parallel servers + tray icons. The second
// server hits port-collision auto-shift and binds 8001, the user has two
// tray icons with no way to tell which is which, and Velopack's
// "apply-update-on-restart" assumption (single instance owns the install
// dir) breaks down. See TODO #4b for the full motivation.
//
// Implementation: a Windows named mutex in the Local namespace, suffixed
// with the current process's token elevation. So we get TWO mutex names:
//   Local\WsScrcpyWeb-SingleInstance-User    (medium integrity)
//   Local\WsScrcpyWeb-SingleInstance-Admin   (high integrity)
//
// This intentionally allows ONE non-elevated instance and ONE elevated
// instance to coexist. The legitimate use case: a user has the normal
// app running (non-elevated, tray-icon, browsing devices), and wants to
// uninstall the service. They right-click → Run as administrator to get
// a second instance with elevated privileges, do the service uninstall,
// then exit the admin instance. If the guard blocked all duplicates,
// that workflow would be impossible.
//
// Same-integrity duplicates are still blocked — two non-elevated
// instances can't both run, two elevated instances can't either.
//
// We do NOT try to focus or message the existing instance — that's a
// separate UX concern (and would require a window-message channel that
// our hidden-console launcher doesn't have today). The user gets a
// no-op exit; the existing instance keeps running with its tray icon.
//
// IMPORTANT: This guard only applies to the NORMAL launcher launch.
// Velopack lifecycle hooks (--veloapp-install / --veloapp-updated /
// --veloapp-uninstall) and elevate-and-run helpers must skip the guard
// because they can legitimately race with a running instance — the hook
// runs alongside, the elevated helper runs alongside. main() handles
// these branches BEFORE acquiring the guard.

#[cfg(windows)]
mod imp {
    use anyhow::Result;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    /// Convert a Rust string to a null-terminated UTF-16 buffer suitable
    /// for the W-suffixed Win32 APIs.
    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Returns true when the current process has an elevated token (i.e.
    /// "Run as administrator" was used). Internally queries the process
    /// token via OpenProcessToken + GetTokenInformation(TokenElevation).
    /// Returns false on any error path — we'd rather under-segregate the
    /// mutex namespace than panic on startup.
    pub fn is_elevated() -> bool {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Security::{
            GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation,
        };
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        unsafe {
            let mut token: HANDLE = HANDLE::default();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
                return false;
            }
            let mut elevation = TOKEN_ELEVATION::default();
            let mut size = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut elevation as *mut _ as *mut std::ffi::c_void),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            );
            let _ = CloseHandle(token);
            if ok.is_err() {
                return false;
            }
            elevation.TokenIsElevated != 0
        }
    }

    /// Holds the OS handle to the named mutex. On Drop the handle is
    /// closed; once all handles to a named mutex close, Windows removes
    /// it automatically. So a normal process exit cleans up correctly,
    /// and a process kill / crash also releases the mutex (Windows
    /// destroys all handles when a process terminates).
    pub struct InstanceGuard {
        handle: windows::Win32::Foundation::HANDLE,
    }

    impl Drop for InstanceGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(self.handle);
            }
        }
    }

    /// Try to acquire the single-instance guard. Returns:
    ///   - Ok(Some(guard)): we are the first / only instance; hold the
    ///     guard for the launcher's lifetime.
    ///   - Ok(None): another instance is already running; caller should
    ///     exit cleanly with status 0.
    ///   - Err(e): something unexpected went wrong creating the mutex
    ///     (very rare — system resource exhaustion, security descriptor
    ///     issue, etc.). Caller should log and proceed without the
    ///     guard rather than block startup.
    pub fn acquire(name: &str) -> Result<Option<InstanceGuard>> {
        use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
        use windows::Win32::System::Threading::CreateMutexW;
        use windows::core::PCWSTR;

        let wide = to_wide(name);
        let handle = unsafe {
            CreateMutexW(None, false, PCWSTR::from_raw(wide.as_ptr()))?
        };
        // CreateMutexW returns a valid handle EVEN when the mutex
        // already existed; GetLastError tells us which case we're in.
        let last = unsafe { GetLastError() };
        if last == ERROR_ALREADY_EXISTS {
            // Close our handle so we don't keep the mutex alive past
            // our exit and force-cascade-cleanup the original holder.
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(handle);
            }
            return Ok(None);
        }
        Ok(Some(InstanceGuard { handle }))
    }
}

#[cfg(not(windows))]
mod imp {
    use anyhow::Result;

    /// Stub guard on non-Windows. Linux service mode goes through systemd
    /// which has its own duplicate-instance handling, and the AppImage
    /// install layout doesn't have the same Start Menu / shortcut
    /// double-launch failure mode. We could add a PID-file approach later
    /// if needed; for now this is a no-op that always says "yes, you're
    /// the only instance."
    pub struct InstanceGuard;

    pub fn acquire(_name: &str) -> Result<Option<InstanceGuard>> {
        Ok(Some(InstanceGuard))
    }

    /// Stub: always false on non-Windows.
    pub fn is_elevated() -> bool {
        false
    }
}

pub use imp::acquire;
#[allow(unused_imports)]
pub use imp::InstanceGuard;

const MUTEX_BASE: &str = r"Local\WsScrcpyWeb-SingleInstance";

/// Build the canonical mutex name for THIS process's elevation level.
/// Two distinct names — `-User` and `-Admin` — let one non-elevated and
/// one elevated instance coexist (legitimate workflow: admin instance
/// for service install/uninstall while normal instance keeps running).
/// Same-integrity duplicates are still blocked because both contenders
/// would try to acquire the same suffixed name.
pub fn current_mutex_name() -> String {
    let suffix = if imp::is_elevated() { "Admin" } else { "User" };
    format!("{MUTEX_BASE}-{suffix}")
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn acquire_grants_first_caller() {
        // Use a unique mutex name to avoid colliding with any real
        // instance running on the test box.
        let name = format!(r"Local\WsScrcpyWeb-Test-{}", uuid_like());
        let guard = acquire(&name).unwrap();
        assert!(guard.is_some(), "first acquire should succeed");
    }

    #[test]
    fn acquire_denies_second_caller_while_first_is_held() {
        let name = format!(r"Local\WsScrcpyWeb-Test-{}", uuid_like());
        let first = acquire(&name).unwrap().expect("first acquire");
        let second = acquire(&name).unwrap();
        assert!(second.is_none(), "second acquire should see ERROR_ALREADY_EXISTS");
        drop(first);
    }

    #[test]
    fn acquire_succeeds_again_after_first_drops() {
        let name = format!(r"Local\WsScrcpyWeb-Test-{}", uuid_like());
        {
            let _g = acquire(&name).unwrap().expect("first acquire");
        }
        // The mutex's last handle was just closed; a new acquire should
        // succeed.
        let again = acquire(&name).unwrap();
        assert!(again.is_some(), "acquire after drop should succeed");
    }

    fn uuid_like() -> String {
        // Cheap unique-enough id for test mutex names — full UUID isn't
        // worth the dep.
        format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }
}
