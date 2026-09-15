use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use regex::Regex;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::{Mutex, RwLock};

#[derive(Clone)]
pub struct HarnessManager {
    child: Arc<Mutex<Option<Child>>>,
    mobile_child: Arc<Mutex<Option<Child>>>,
    current_url: Arc<RwLock<Option<String>>>,
    status: Arc<RwLock<String>>,
    mobile_connected: Arc<RwLock<bool>>,
}

impl HarnessManager {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            mobile_child: Arc::new(Mutex::new(None)),
            current_url: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new("idle".to_string())),
            mobile_connected: Arc::new(RwLock::new(false)),
        }
    }

    pub async fn is_mobile_connected(&self) -> bool {
        *self.mobile_connected.read().await
    }

    fn find_project_root() -> PathBuf {
        let mut curr = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        for _ in 0..6 {
            if curr.join("node_modules/@deepseek-ai/dsh/lib/bin.js").exists() {
                return curr;
            }
            if let Some(parent) = curr.parent() {
                curr = parent.to_path_buf();
            } else {
                break;
            }
        }
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    }

    fn find_node_executable(root: &Path) -> PathBuf {
        let bundled_local = if cfg!(windows) {
            root.join("node_modules/node/bin/node.exe")
        } else {
            root.join("node_modules/node/bin/node")
        };
        if bundled_local.exists() {
            return bundled_local;
        }

        PathBuf::from("node")
    }

    fn get_user_data_path() -> PathBuf {
        #[cfg(target_os = "macos")]
        {
            if let Some(home) = dirs::home_dir() {
                return home.join("Library/Application Support/dsh-desktop");
            }
        }
        #[cfg(target_os = "windows")]
        {
            if let Some(app_data) = dirs::data_dir() {
                return app_data.join("dsh-desktop");
            }
        }
        if let Some(data) = dirs::data_dir() {
            data.join("dsh-desktop")
        } else {
            dirs::home_dir().unwrap_or_default().join(".dsh")
        }
    }

    pub async fn start(&self, app: &AppHandle) -> Result<(), String> {
        let mut child_guard = self.child.lock().await;
        if child_guard.is_some() {
            log::info!("[harness] Process is already running");
            return Ok(());
        }

        let root = Self::find_project_root();
        let node_bin = Self::find_node_executable(&root);
        let entry_mjs = root.join("build/harness-node-entry.mjs");
        let dsh_bin = root.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
        let patch_yml = root.join("build/dsh-desktop.patch.yml");

        if !dsh_bin.exists() {
            let err = format!("DSH bin.js not found at: {}", dsh_bin.display());
            log::error!("{}", err);
            return Err(err);
        }

        let user_data = Self::get_user_data_path();
        let dsh_home = user_data.join("harness");
        let launch_root = user_data.join("launch-root");

        let _ = tokio::fs::create_dir_all(&dsh_home).await;
        let _ = tokio::fs::create_dir_all(&launch_root).await;

        log::info!("[harness] Starting Harness using node: {}", node_bin.display());
        log::info!("[harness] Entry script: {}", entry_mjs.display());
        log::info!("[harness] DSH bin: {}", dsh_bin.display());
        log::info!("[harness] DSH_HOME: {}", dsh_home.display());
        log::info!("[harness] Launch root: {}", launch_root.display());

        let node_modules_path = root.join("node_modules");
        let packages_path = root.join("packages");
        let node_path = format!("{}:{}", node_modules_path.display(), packages_path.display());

        let mut cmd = tokio::process::Command::new(&node_bin);
        cmd.arg("--expose-internals")
            .arg(&entry_mjs)
            .arg(&dsh_bin)
            .arg("web")
            .arg("--patch")
            .arg(&patch_yml)
            .arg("--no-open")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg("43125")
            .current_dir(&launch_root)
            .env("DSH_HOME", &dsh_home)
            .env("NODE_PATH", &node_path)
            .env("NO_COLOR", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            let err = format!("Failed to spawn Harness node process: {}", e);
            log::error!("{}", err);
            err
        })?;

        let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

        *child_guard = Some(child);
        *self.status.write().await = "starting".to_string();

        let app_clone = app.clone();
        let current_url = self.current_url.clone();
        let status = self.status.clone();
        let mobile_child_arc = self.mobile_child.clone();
        let mobile_connected_arc = self.mobile_connected.clone();
        let root_clone = root.clone();
        let node_bin_clone = node_bin.clone();
        let user_data_clone = user_data.clone();

        // Spawn stdout monitoring task
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            let url_regex = Regex::new(r"dsh web:\s*(\S+)").unwrap();

            while let Ok(Some(line)) = lines.next_line().await {
                log::info!("[harness stdout] {}", line);

                if let Some(caps) = url_regex.captures(&line) {
                    if let Some(matched_url) = caps.get(1) {
                        let url_str = matched_url.as_str().to_string();
                        log::info!("[harness] Extracted Harness URL: {}", url_str);
                        *current_url.write().await = Some(url_str.clone());
                        *status.write().await = "ready".to_string();

                        // Navigate main window to Harness URL
                        if let Some(window) = app_clone.get_webview_window("main") {
                            log::info!("[harness] Navigating main window to: {}", url_str);
                            if let Ok(parsed_url) = url::Url::parse(&url_str) {
                                let _ = window.navigate(parsed_url);
                            }
                        }

                        // Extract token and start mobile bridge
                        let token = url::Url::parse(&url_str)
                            .ok()
                            .and_then(|u| {
                                u.query_pairs()
                                    .find(|(k, _)| k == "token")
                                    .map(|(_, v)| v.to_string())
                            })
                            .unwrap_or_default();

                        let mobile_runner = root_clone.join("build/mobile-bridge-runner.mjs");
                        if mobile_runner.exists() {
                            log::info!("[mobile] Spawning Mobile Bridge: {}", mobile_runner.display());
                            let mut mobile_cmd = tokio::process::Command::new(&node_bin_clone);
                            mobile_cmd.arg(&mobile_runner)
                                .arg("--harness-url")
                                .arg("http://127.0.0.1:43125")
                                .arg("--token")
                                .arg(&token)
                                .arg("--port")
                                .arg("43127")
                                .arg("--user-data")
                                .arg(&user_data_clone)
                                .current_dir(&root_clone)
                                .stdout(Stdio::piped())
                                .stderr(Stdio::piped());

                            if let Ok(mut mob_child) = mobile_cmd.spawn() {
                                let mob_stdout = mob_child.stdout.take();
                                *mobile_child_arc.lock().await = Some(mob_child);

                                let conn_state = mobile_connected_arc.clone();
                                if let Some(out) = mob_stdout {
                                    tokio::spawn(async move {
                                        let mut mob_lines = BufReader::new(out).lines();
                                        while let Ok(Some(mline)) = mob_lines.next_line().await {
                                            log::info!("[mobile-bridge stdout] {}", mline);
                                            if mline.contains("connected: true") {
                                                *conn_state.write().await = true;
                                            } else if mline.contains("connected: false") {
                                                *conn_state.write().await = false;
                                            }
                                        }
                                    });
                                }
                            }
                        }
                    }
                }
            }
            log::warn!("[harness] stdout stream closed");
        });

        // Spawn stderr monitoring task
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::warn!("[harness stderr] {}", line);
            }
        });

        Ok(())
    }

    #[allow(dead_code)]
    pub async fn stop(&self) {
        let mut child_guard = self.child.lock().await;
        if let Some(mut child) = child_guard.take() {
            log::info!("[harness] Stopping child process...");
            let _ = child.kill().await;
        }
        let mut mob_guard = self.mobile_child.lock().await;
        if let Some(mut mob_child) = mob_guard.take() {
            log::info!("[mobile] Stopping mobile bridge process...");
            let _ = mob_child.kill().await;
        }
    }

    pub fn stop_blocking(&self) {
        if let Ok(mut guard) = self.child.try_lock() {
            if let Some(mut child) = guard.take() {
                log::info!("[harness] Terminating child process on exit...");
                let _ = child.start_kill();
            }
        }
        if let Ok(mut mob_guard) = self.mobile_child.try_lock() {
            if let Some(mut mob_child) = mob_guard.take() {
                log::info!("[mobile] Terminating mobile bridge on exit...");
                let _ = mob_child.start_kill();
            }
        }
    }

    pub async fn restart(&self, app: &AppHandle) -> Result<(), String> {
        log::info!("[harness] Restarting Harness process...");
        {
            let mut child_guard = self.child.lock().await;
            if let Some(mut child) = child_guard.take() {
                let _ = child.kill().await;
            }
        }
        {
            let mut mob_guard = self.mobile_child.lock().await;
            if let Some(mut mob_child) = mob_guard.take() {
                let _ = mob_child.kill().await;
            }
        }
        *self.current_url.write().await = None;
        *self.status.write().await = "restarting".to_string();
        *self.mobile_connected.write().await = false;

        // Navigate window back to splash while restarting
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(splash_url) = url::Url::parse("tauri://localhost/index.html") {
                let _ = window.navigate(splash_url);
            }
        }

        self.start(app).await
    }
}
