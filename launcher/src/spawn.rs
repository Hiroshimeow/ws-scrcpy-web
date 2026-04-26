// Node child-process spawn for the launcher.
//
// Resolves the Node executable using a strict priority chain:
//   1. `DEPS_PATH` env var → `<DEPS_PATH>/node/node.exe` (per SP2b strict
//      semantics — if DEPS_PATH is set but missing, hard fail; do NOT fall
//      through to seed/).
//   2. Otherwise, `<exe_dir>/seed/node/node.exe` (bundled fallback for
//      first-run before dependencies/ is populated).
//   3. Otherwise, error.
//
// Server entry is `<exe_dir>/dist/index.js`.

use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

// CREATE_NO_WINDOW = 0x08000000. Defined here as a literal so we don't need
// to thread the windows crate through pure-logic functions / tests on
// non-Windows hosts (when those happen — e.g., CI matrix expansion).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Pure resolution: given an optional DEPS_PATH and an exe directory,
/// return the Node binary path or an error.
pub fn resolve_node_with(deps_path: Option<&str>, exe_dir: &Path) -> Result<PathBuf> {
    if let Some(deps) = deps_path {
        let candidate = Path::new(deps).join("node").join("node.exe");
        if candidate.exists() {
            return Ok(candidate);
        }
        // Strict mode — DEPS_PATH was set, so we MUST use it. No fallback.
        bail!(
            "DEPS_PATH is set to {:?} but Node not found at {:?}",
            deps,
            candidate
        );
    }

    let seed = exe_dir.join("seed").join("node").join("node.exe");
    if seed.exists() {
        return Ok(seed);
    }

    bail!(
        "Node not found. Set DEPS_PATH or place a Node binary at {:?}",
        seed
    )
}

/// Resolve Node using process env + current exe path.
pub fn resolve_node() -> Result<PathBuf> {
    let deps = std::env::var("DEPS_PATH").ok();
    let exe = std::env::current_exe().context("could not determine current exe path")?;
    let exe_dir = exe.parent().context("exe has no parent dir")?;
    resolve_node_with(deps.as_deref(), exe_dir)
}

/// Pure resolution for the server entry point.
pub fn resolve_server_entry_with(exe_dir: &Path) -> Result<PathBuf> {
    let entry = exe_dir.join("dist").join("index.js");
    if entry.exists() {
        Ok(entry)
    } else {
        bail!("Server entry not found at {:?}", entry)
    }
}

pub fn resolve_server_entry() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("could not determine current exe path")?;
    let exe_dir = exe.parent().context("exe has no parent dir")?;
    resolve_server_entry_with(exe_dir)
}

/// Spawn the Node server with hidden console window.
///
/// Returns the child handle so the caller (supervisor) can wait on it.
#[cfg(windows)]
pub fn spawn_server() -> Result<Child> {
    use std::os::windows::process::CommandExt;

    let node = resolve_node()?;
    let entry = resolve_server_entry()?;
    let exe = std::env::current_exe()?;
    let work_dir = exe.parent().context("exe has no parent dir")?.to_path_buf();

    let child = Command::new(&node)
        .arg(&entry)
        .current_dir(&work_dir)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .with_context(|| format!("failed to spawn {:?} {:?}", node, entry))?;

    Ok(child)
}

#[cfg(not(windows))]
pub fn spawn_server() -> Result<Child> {
    let node = resolve_node()?;
    let entry = resolve_server_entry()?;
    let exe = std::env::current_exe()?;
    let work_dir = exe.parent().context("exe has no parent dir")?.to_path_buf();

    let child = Command::new(&node)
        .arg(&entry)
        .current_dir(&work_dir)
        .spawn()
        .with_context(|| format!("failed to spawn {:?} {:?}", node, entry))?;

    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"stub").unwrap();
    }

    #[test]
    fn resolve_node_uses_deps_path_when_present() {
        let dir = tempdir().unwrap();
        let deps = dir.path().join("deps");
        let node = deps.join("node").join("node.exe");
        touch(&node);

        let exe_dir = dir.path().join("exe");
        fs::create_dir_all(&exe_dir).unwrap();

        let resolved = resolve_node_with(Some(deps.to_str().unwrap()), &exe_dir).unwrap();
        assert_eq!(resolved, node);
    }

    #[test]
    fn resolve_node_strict_fails_when_deps_path_missing() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("exe");
        fs::create_dir_all(&exe_dir).unwrap();

        let bogus = dir.path().join("nope");
        let err = resolve_node_with(Some(bogus.to_str().unwrap()), &exe_dir).unwrap_err();
        assert!(err.to_string().contains("DEPS_PATH is set"));
    }

    #[test]
    fn resolve_node_falls_back_to_seed_when_deps_path_unset() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("exe");
        let seed = exe_dir.join("seed").join("node").join("node.exe");
        touch(&seed);

        let resolved = resolve_node_with(None, &exe_dir).unwrap();
        assert_eq!(resolved, seed);
    }

    #[test]
    fn resolve_node_errors_when_neither_present() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("exe");
        fs::create_dir_all(&exe_dir).unwrap();

        let err = resolve_node_with(None, &exe_dir).unwrap_err();
        assert!(err.to_string().contains("Node not found"));
    }

    #[test]
    fn resolve_server_entry_finds_dist_index_js() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("exe");
        let entry = exe_dir.join("dist").join("index.js");
        touch(&entry);

        let resolved = resolve_server_entry_with(&exe_dir).unwrap();
        assert_eq!(resolved, entry);
    }

    #[test]
    fn resolve_server_entry_errors_when_missing() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("exe");
        fs::create_dir_all(&exe_dir).unwrap();

        let err = resolve_server_entry_with(&exe_dir).unwrap_err();
        assert!(err.to_string().contains("Server entry not found"));
    }
}
