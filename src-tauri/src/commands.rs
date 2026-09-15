use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use crate::harness::HarnessManager;

#[tauri::command]
pub async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_folder(move |folder_path| {
        let _ = tx.send(folder_path.map(|p| p.to_string()));
    });
    rx.await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restart_harness(
    app: AppHandle,
    state: State<'_, HarnessManager>,
) -> Result<(), String> {
    log::info!("[tauri-cmd] restart_harness invoked");
    state.restart(&app).await
}

#[tauri::command]
pub async fn open_in_finder(path: String) -> Result<(), String> {
    log::info!("[tauri-cmd] open_in_finder: {}", path);
    #[cfg(target_os = "macos")]
    {
        let path_buf = PathBuf::from(&path);
        let arg = if path_buf.is_file() { "-R" } else { "" };
        let mut cmd = std::process::Command::new("open");
        if !arg.is_empty() {
            cmd.arg(arg);
        }
        cmd.arg(&path);
        cmd.spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        let path_buf = PathBuf::from(&path);
        let mut cmd = std::process::Command::new("explorer");
        if path_buf.is_file() {
            cmd.arg(format!("/select,{}", path));
        } else {
            cmd.arg(&path);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        open::that_detached(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn mobile_status(state: State<'_, HarnessManager>) -> Result<serde_json::Value, String> {
    let connected = state.is_mobile_connected().await;
    Ok(serde_json::json!({ "connected": connected }))
}

#[tauri::command]
pub async fn mobile_open_pairing(app: AppHandle) -> Result<(), String> {
    log::info!("[tauri-cmd] mobile_open_pairing invoked");
    if let Some(win) = app.get_webview_window("mobile-pairing") {
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        let url = url::Url::parse("http://127.0.0.1:43127")
            .map_err(|e| format!("Failed to parse mobile URL: {}", e))?;
        let _ = tauri::WebviewWindowBuilder::new(
            &app,
            "mobile-pairing",
            tauri::WebviewUrl::External(url),
        )
        .title("连接移动设备")
        .inner_size(560.0, 720.0)
        .min_inner_size(420.0, 560.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("Failed to create mobile window: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn uninstall_market(_state: State<'_, HarnessManager>) -> Result<(), String> {
    log::info!("[tauri-cmd] uninstall_market invoked");
    Ok(())
}

#[tauri::command]
pub async fn recovery_action(action: String) -> Result<(), String> {
    log::info!("[tauri-cmd] recovery_action: {}", action);
    Ok(())
}

#[tauri::command]
pub async fn web_import_action(action: String) -> Result<(), String> {
    log::info!("[tauri-cmd] web_import_action: {}", action);
    Ok(())
}

#[tauri::command]
pub async fn safe_mode_action(
    action: String,
    selection: serde_json::Value,
) -> Result<(), String> {
    log::info!("[tauri-cmd] safe_mode_action: {} with {:?}", action, selection);
    Ok(())
}
