#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    configure_linux_webkitgtk_environment();
    canopi_desktop::run();
}

#[cfg(target_os = "linux")]
fn configure_linux_webkitgtk_environment() {
    // WebKitGTK's default DMA-BUF renderer can deadlock WebGL context creation
    // on affected Linux systems. MapLibre requires WebGL, so this must run
    // before Tauri initializes WebKit and its child processes.
    configure_linux_webkitgtk_environment_with(|key, value| {
        // SAFETY: `main` calls this before Tauri starts any WebKit, runtime, or
        // worker threads.
        unsafe {
            std::env::set_var(key, value);
        }
    });
}

#[cfg(target_os = "linux")]
fn configure_linux_webkitgtk_environment_with(mut set_var: impl FnMut(&'static str, &'static str)) {
    // upstream: W10
    set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_webkitgtk_environment() {}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn configures_webkitgtk_dmabuf_renderer_before_tauri_startup() {
        let mut configured_vars = Vec::new();

        super::configure_linux_webkitgtk_environment_with(|key, value| {
            configured_vars.push((key, value));
        });

        assert_eq!(
            configured_vars,
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")],
        );
    }
}
