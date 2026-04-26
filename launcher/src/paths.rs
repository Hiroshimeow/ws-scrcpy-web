// Canonical path resolution for the install layout.
//
// Production layout:
//   <installRoot>/
//     ws-scrcpy-web.exe       (Velopack stub)
//     Update.exe              (Velopack updater)
//     config.json
//     current/                (Velopack-managed; wiped on update)
//       ws-scrcpy-web-launcher.exe   <-- exe_dir
//       dist/, seed/, ...
//     dependencies/           (DEPS_PATH target — sibling of current/)
//
// Dev layout (target/debug or target/release):
//   target/debug/ws-scrcpy-web-launcher.exe    <-- exe_dir
//   <project>/                                 <-- exe_dir.parent().parent()
//
// The launcher's `exe_dir` is `<installRoot>/current/` in production.
// `install_root` is its parent.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

pub struct Paths {
    pub install_root: PathBuf,
    pub deps_path: PathBuf,
    pub restart_marker: PathBuf,
    pub old_node: PathBuf,
}

impl Paths {
    /// Compute paths from a known exe directory + an optional explicit
    /// DEPS_PATH override. If `deps_override` is `Some`, that path is used
    /// directly (matches the resolution priority in spawn::resolve_node).
    pub fn compute(exe_dir: &Path, deps_override: Option<&str>) -> Result<Self> {
        let install_root = exe_dir
            .parent()
            .context("exe_dir has no parent (cannot derive install_root)")?
            .to_path_buf();

        let deps_path = match deps_override {
            Some(p) => PathBuf::from(p),
            None => install_root.join("dependencies"),
        };

        let restart_marker = deps_path.join(".restart");
        let old_node = deps_path.join("node").join("node.exe.old");

        Ok(Self {
            install_root,
            deps_path,
            restart_marker,
            old_node,
        })
    }

    /// Compute paths from process state.
    pub fn from_env() -> Result<Self> {
        let exe = std::env::current_exe().context("could not determine current exe path")?;
        let exe_dir = exe
            .parent()
            .context("exe has no parent dir")?
            .to_path_buf();
        let deps_override = std::env::var("DEPS_PATH").ok();
        Self::compute(&exe_dir, deps_override.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn compute_uses_install_root_for_default_deps_path() {
        let dir = tempdir().unwrap();
        let install_root = dir.path();
        let exe_dir = install_root.join("current");
        std::fs::create_dir_all(&exe_dir).unwrap();

        let paths = Paths::compute(&exe_dir, None).unwrap();
        assert_eq!(paths.install_root, install_root);
        assert_eq!(paths.deps_path, install_root.join("dependencies"));
        assert_eq!(
            paths.restart_marker,
            install_root.join("dependencies").join(".restart")
        );
        assert_eq!(
            paths.old_node,
            install_root
                .join("dependencies")
                .join("node")
                .join("node.exe.old")
        );
    }

    #[test]
    fn compute_respects_deps_override() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("current");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let custom = dir.path().join("custom-deps");

        let paths = Paths::compute(&exe_dir, Some(custom.to_str().unwrap())).unwrap();
        assert_eq!(paths.deps_path, custom);
        assert_eq!(paths.restart_marker, custom.join(".restart"));
    }
}
