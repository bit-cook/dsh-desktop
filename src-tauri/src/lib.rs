mod commands;
mod harness;

use harness::HarnessManager;
use tauri::{WebviewUrl, WebviewWindowBuilder};

pub fn run() {
    let _ = env_logger::try_init();

    let harness_manager = HarnessManager::new();
    let harness_manager_setup = harness_manager.clone();
    let harness_manager_cleanup = harness_manager.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(harness_manager)
        .invoke_handler(tauri::generate_handler![
            commands::pick_directory,
            commands::restart_harness,
            commands::open_in_finder,
            commands::mobile_status,
            commands::mobile_open_pairing,
            commands::uninstall_market,
            commands::recovery_action,
            commands::web_import_action,
            commands::safe_mode_action,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let manager = harness_manager_setup;

            let preload_script = include_str!("../ui/preload-tauri.js");

            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("DeepSeek Harness")
            .inner_size(1280.0, 820.0)
            .min_inner_size(800.0, 600.0)
            .initialization_script(preload_script)
            .build()?;

            let _ = window.show();

            // Start Harness in background
            tauri::async_runtime::spawn(async move {
                if let Err(e) = manager.start(&app_handle).await {
                    log::error!("[setup] Failed to start Harness: {}", e);
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run({
            let manager = harness_manager_cleanup;
            move |_app_handle, event| {
                if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                    manager.stop_blocking();
                }
            }
        });
}
