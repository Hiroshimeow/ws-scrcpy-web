// Windows Job Object that owns the Node child + its descendants.
//
// Without this, killing the launcher (Servy stop, Task Manager, MSI uninstall)
// can leave the Node grandchild + its node-pty descendants resident. v0.1.21
// shipped with that bug visible as: orphaned node.exe after service uninstall,
// and `pty.node` MSI-renamed to `C:\Config.Msi\<id>.rbf` because the running
// Node process still held the .node loaded.
//
// Pattern: a single process-wide unnamed Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. The launcher holds the only handle for
// its full lifetime — when the launcher process exits (graceful or killed),
// the OS closes the last handle, the job destructs, and Windows terminates
// every process in the job (Node + node-pty + scrcpy.exe etc.). Job
// membership is inherited by default, so children spawned by Node also land
// in the job automatically.
//
// Failure modes are swallowed (return Err to the caller, which logs and
// continues). Reasons:
//   - launcher itself in a parent job that doesn't allow nesting (rare on
//     modern Windows but possible under some MDM / debugger configurations)
//   - ERROR_ACCESS_DENIED on OpenProcess if the child somehow lost privileges
// In any of these cases we want the launcher to keep running with v0.1.21
// behavior (graceful degradation) rather than refuse to start.

use anyhow::{Context, Result, anyhow};
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::sync::OnceLock;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows::core::PCWSTR;

struct JobHandle(HANDLE);
// SAFETY: HANDLE is an integer-sized opaque value; the Windows kernel handles
// thread safety on the operations we perform (AssignProcessToJobObject is
// documented as thread-safe).
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

static JOB: OnceLock<Option<JobHandle>> = OnceLock::new();

fn create_job() -> Option<HANDLE> {
    unsafe {
        let job = CreateJobObjectW(None, PCWSTR::null()).ok()?;

        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let res = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if res.is_err() {
            let _ = CloseHandle(job);
            return None;
        }
        Some(job)
    }
}

/// Assign the spawned child to the launcher's process-wide kill-on-close
/// Job Object. Idempotent across calls (re-assigning the same process is a
/// no-op error which we ignore); but in our codebase we only ever spawn one
/// supervised Node child at a time.
pub fn adopt(child: &Child) -> Result<()> {
    let job_handle = JOB
        .get_or_init(|| create_job().map(JobHandle))
        .as_ref()
        .ok_or_else(|| anyhow!("could not create Job Object"))?
        .0;

    let raw = child.as_raw_handle();
    let proc = HANDLE(raw);
    unsafe {
        AssignProcessToJobObject(job_handle, proc).context("AssignProcessToJobObject failed")?;
    }
    Ok(())
}
