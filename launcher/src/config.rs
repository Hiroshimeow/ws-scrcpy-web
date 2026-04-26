// Read-only Rust view of `<installRoot>/config.json`.
//
// Mirrors only the three fields the Rust launcher needs for hook decisions
// (per SP3 P2 Contract 1). The TS source of truth is `src/server/Config.ts`.
//
// Behavior:
//   - Missing file -> `AppConfig::default()`.
//   - Malformed JSON -> log warning, return `AppConfig::default()` (do NOT
//     fail the hook; recovery during install/uninstall must not block on a
//     bad config file).
//   - Missing fields -> serde defaults via `#[serde(default)]`.

use serde::Deserialize;
use std::path::Path;

use crate::log;

#[derive(Debug, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct AppConfig {
    #[serde(rename = "installMode")]
    pub install_mode: Option<String>,
    #[serde(rename = "firstRunComplete")]
    pub first_run_complete: bool,
    #[serde(rename = "webPort")]
    pub web_port: Option<u16>,
}

impl AppConfig {
    /// `installMode` ends in `-service` (i.e., service-mode install).
    pub fn is_service_mode(&self) -> bool {
        self.install_mode
            .as_deref()
            .is_some_and(|m| m.ends_with("-service"))
    }

    /// Read from a specific path. Missing file -> default. Bad JSON -> default + warn.
    pub fn load_from(path: &Path) -> Self {
        if !path.exists() {
            return Self::default();
        }
        match std::fs::read_to_string(path) {
            Ok(text) => match serde_json::from_str::<AppConfig>(&text) {
                Ok(cfg) => cfg,
                Err(e) => {
                    log::error(&format!(
                        "config: failed to parse {path:?}: {e}; using defaults"
                    ));
                    Self::default()
                }
            },
            Err(e) => {
                log::error(&format!(
                    "config: failed to read {path:?}: {e}; using defaults"
                ));
                Self::default()
            }
        }
    }

    /// Read from `<install_root>/config.json`.
    pub fn load(install_root: &Path) -> Self {
        Self::load_from(&install_root.join("config.json"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn missing_file_returns_default() {
        let dir = tempdir().unwrap();
        let cfg = AppConfig::load(dir.path());
        assert_eq!(cfg, AppConfig::default());
        assert_eq!(cfg.install_mode, None);
        assert!(!cfg.first_run_complete);
        assert_eq!(cfg.web_port, None);
    }

    #[test]
    fn parses_well_formed_json() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            r#"{"installMode":"user-service","firstRunComplete":true,"webPort":8001}"#,
        )
        .unwrap();

        let cfg = AppConfig::load(dir.path());
        assert_eq!(cfg.install_mode.as_deref(), Some("user-service"));
        assert!(cfg.first_run_complete);
        assert_eq!(cfg.web_port, Some(8001));
        assert!(cfg.is_service_mode());
    }

    #[test]
    fn missing_fields_use_defaults() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, r#"{"webPort":9000}"#).unwrap();

        let cfg = AppConfig::load(dir.path());
        assert_eq!(cfg.install_mode, None);
        assert!(!cfg.first_run_complete);
        assert_eq!(cfg.web_port, Some(9000));
    }

    #[test]
    fn ignores_unknown_fields() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            r#"{"installMode":"user","autoUpdate":true,"channel":"beta","githubOwner":"x"}"#,
        )
        .unwrap();

        let cfg = AppConfig::load(dir.path());
        assert_eq!(cfg.install_mode.as_deref(), Some("user"));
        assert!(!cfg.is_service_mode());
    }

    #[test]
    fn invalid_json_returns_default() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "{not valid json").unwrap();

        let cfg = AppConfig::load(dir.path());
        assert_eq!(cfg, AppConfig::default());
    }

    #[test]
    fn empty_file_returns_default() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "").unwrap();

        let cfg = AppConfig::load(dir.path());
        assert_eq!(cfg, AppConfig::default());
    }

    #[test]
    fn is_service_mode_recognizes_both_service_variants() {
        let mk = |mode: Option<&str>| AppConfig {
            install_mode: mode.map(|s| s.to_string()),
            ..Default::default()
        };
        assert!(!mk(Some("user")).is_service_mode());
        assert!(mk(Some("user-service")).is_service_mode());
        assert!(mk(Some("system-service")).is_service_mode());
        assert!(!mk(Some("system")).is_service_mode());
        assert!(!mk(None).is_service_mode());
    }
}
