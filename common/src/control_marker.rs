use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Marker {
    pub verb: String,
    #[serde(rename = "targetSessionId")]
    pub target_session_id: Option<u32>,
    #[serde(rename = "launcherPath")]
    pub launcher_path: PathBuf,
    #[serde(rename = "launcherArgs")]
    pub launcher_args: Vec<String>,
    #[serde(rename = "writtenAt")]
    pub written_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_round_trips_through_json() {
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from(r"C:\Program Files\WsScrcpyWeb\current\ws-scrcpy-web-launcher.exe"),
            launcher_args: vec!["--local-takeover".to_string()],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        let json = serde_json::to_string(&m).expect("serialize");
        let back: Marker = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(m, back);
    }
}
