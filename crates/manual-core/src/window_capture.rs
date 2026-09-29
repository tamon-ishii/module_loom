use serde::Serialize;

pub(crate) fn is_wayland_session() -> bool {
    #[cfg(target_os = "linux")]
    {
        match std::env::var("XDG_SESSION_TYPE").ok().as_deref() {
            Some(session) if session.eq_ignore_ascii_case("wayland") => true,
            Some(session) if session.eq_ignore_ascii_case("x11") => false,
            _ => std::env::var("WAYLAND_DISPLAY").is_ok_and(|display| !display.is_empty()),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowInfo {
    pub id: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{is_wayland_session, WindowInfo};
    use ashpd::desktop::screenshot::{AvailableTargets, Screenshot};
    use image::{ImageBuffer, Rgb};
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_int, c_long, c_uchar, c_ulong, c_void};
    use std::path::Path;
    use std::ptr;
    use std::thread;
    use std::time::Duration;
    use x11_dl::xlib;

    const PORTAL_WINDOW_ID: &str = "portal";

    fn capture_portal(inset: u32, destination: &Path) -> Result<WindowInfo, String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("Could not start screenshot portal: {error}"))?;
        let uri = runtime.block_on(async {
            let response = Screenshot::request()
                .interactive(true)
                .target(AvailableTargets::Window)
                .send()
                .await
                .map_err(|error| format!("Screenshot portal request failed: {error}"))?
                .response()
                .map_err(|error| format!("Screenshot was cancelled or denied: {error}"))?;
            Ok::<String, String>(response.uri().to_string())
        })?;
        let source = url::Url::parse(&uri)
            .map_err(|error| format!("Invalid screenshot URI: {error}"))?
            .to_file_path()
            .map_err(|_| "Screenshot portal did not return a local file")?;
        let image = image::open(&source)
            .map_err(|error| format!("Could not read portal screenshot: {error}"))?;
        let crop = inset.checked_mul(2).ok_or("Inset is too large")?;
        let width = image
            .width()
            .checked_sub(crop)
            .ok_or("Inset exceeds captured image width")?;
        let height = image
            .height()
            .checked_sub(crop)
            .ok_or("Inset exceeds captured image height")?;
        if width == 0 || height == 0 {
            return Err("Capture area is empty".into());
        }
        image
            .crop_imm(inset, inset, width, height)
            .save(destination)
            .map_err(|error| error.to_string())?;
        Ok(WindowInfo {
            id: PORTAL_WINDOW_ID.into(),
            title: "Selected window".into(),
            x: 0,
            y: 0,
            width,
            height,
        })
    }

    struct DisplayConnection {
        api: xlib::Xlib,
        display: *mut xlib::Display,
        root: xlib::Window,
    }

    impl Drop for DisplayConnection {
        fn drop(&mut self) {
            unsafe {
                (self.api.XCloseDisplay)(self.display);
            }
        }
    }

    impl DisplayConnection {
        fn open() -> Result<Self, String> {
            let api = xlib::Xlib::open().map_err(|error| format!("X11 is unavailable: {error}"))?;
            let display = unsafe { (api.XOpenDisplay)(ptr::null()) };
            if display.is_null() {
                return Err("Cannot open the X11 display. Window capture currently requires a Linux X11 session".into());
            }
            let root = unsafe { (api.XDefaultRootWindow)(display) };
            Ok(Self { api, display, root })
        }

        fn atom(&self, name: &str) -> xlib::Atom {
            let name = CString::new(name).expect("static atom name");
            unsafe { (self.api.XInternAtom)(self.display, name.as_ptr(), xlib::False) }
        }

        fn property(&self, window: xlib::Window, name: &str) -> Option<(c_int, Vec<u8>)> {
            let atom = self.atom(name);
            let mut actual_type = 0;
            let mut format = 0;
            let mut count = 0;
            let mut after = 0;
            let mut data: *mut c_uchar = ptr::null_mut();
            let status = unsafe {
                (self.api.XGetWindowProperty)(
                    self.display,
                    window,
                    atom,
                    0,
                    4096,
                    xlib::False,
                    0,
                    &mut actual_type,
                    &mut format,
                    &mut count,
                    &mut after,
                    &mut data,
                )
            };
            if status != 0 || data.is_null() || !matches!(format, 8 | 32) {
                if !data.is_null() {
                    unsafe {
                        (self.api.XFree)(data.cast::<c_void>());
                    }
                }
                return None;
            }
            let element_size = if format == 32 {
                std::mem::size_of::<c_ulong>()
            } else {
                1
            };
            let bytes =
                unsafe { std::slice::from_raw_parts(data, count as usize * element_size).to_vec() };
            unsafe {
                (self.api.XFree)(data.cast::<c_void>());
            }
            Some((format, bytes))
        }

        fn client_windows(&self) -> Result<Vec<xlib::Window>, String> {
            let (format, bytes) = self
                .property(self.root, "_NET_CLIENT_LIST")
                .ok_or("The window manager does not expose its window list")?;
            if format != 32 {
                return Err("Unexpected X11 window list format".into());
            }
            let width = std::mem::size_of::<c_ulong>();
            Ok(bytes
                .chunks_exact(width)
                .map(|chunk| {
                    let mut native = [0u8; std::mem::size_of::<c_ulong>()];
                    native.copy_from_slice(chunk);
                    c_ulong::from_ne_bytes(native)
                })
                .collect())
        }

        fn title(&self, window: xlib::Window) -> Option<String> {
            if let Some((8, bytes)) = self.property(window, "_NET_WM_NAME") {
                let text = String::from_utf8_lossy(&bytes)
                    .trim_end_matches('\0')
                    .to_string();
                if !text.is_empty() {
                    return Some(text);
                }
            }
            let mut raw = ptr::null_mut();
            let success = unsafe { (self.api.XFetchName)(self.display, window, &mut raw) };
            if success == 0 || raw.is_null() {
                return None;
            }
            let text = unsafe { CStr::from_ptr(raw).to_string_lossy().into_owned() };
            unsafe {
                (self.api.XFree)(raw.cast::<c_void>());
            }
            (!text.is_empty()).then_some(text)
        }

        fn info(&self, window: xlib::Window) -> Option<WindowInfo> {
            let mut attr = std::mem::MaybeUninit::<xlib::XWindowAttributes>::uninit();
            if unsafe { (self.api.XGetWindowAttributes)(self.display, window, attr.as_mut_ptr()) }
                == 0
            {
                return None;
            }
            let attr = unsafe { attr.assume_init() };
            if attr.map_state != xlib::IsViewable || attr.width < 1 || attr.height < 1 {
                return None;
            }
            let mut x = 0;
            let mut y = 0;
            let mut child = 0;
            if unsafe {
                (self.api.XTranslateCoordinates)(
                    self.display,
                    window,
                    self.root,
                    0,
                    0,
                    &mut x,
                    &mut y,
                    &mut child,
                )
            } == 0
            {
                return None;
            }
            Some(WindowInfo {
                id: format!("0x{window:x}"),
                title: self.title(window)?,
                x,
                y,
                width: attr.width as u32,
                height: attr.height as u32,
            })
        }

        fn send_message(&self, window: xlib::Window, name: &str, data: [c_long; 5]) {
            let message = xlib::XClientMessageEvent {
                type_: xlib::ClientMessage,
                serial: 0,
                send_event: xlib::True,
                display: self.display,
                window,
                message_type: self.atom(name),
                format: 32,
                data: xlib::ClientMessageData::from(data),
            };
            let mut event = xlib::XEvent {
                client_message: message,
            };
            unsafe {
                (self.api.XSendEvent)(
                    self.display,
                    self.root,
                    xlib::False,
                    xlib::SubstructureRedirectMask | xlib::SubstructureNotifyMask,
                    &mut event,
                );
                (self.api.XFlush)(self.display);
            }
        }

        fn set_above(&self, window: xlib::Window, add: bool) {
            self.send_message(
                window,
                "_NET_WM_STATE",
                [
                    if add { 1 } else { 0 },
                    self.atom("_NET_WM_STATE_ABOVE") as c_long,
                    0,
                    2,
                    0,
                ],
            );
        }

        fn activate(&self, window: xlib::Window) {
            self.send_message(window, "_NET_ACTIVE_WINDOW", [2, 0, 0, 0, 0]);
            unsafe {
                (self.api.XRaiseWindow)(self.display, window);
                (self.api.XSetInputFocus)(
                    self.display,
                    window,
                    xlib::RevertToParent,
                    xlib::CurrentTime,
                );
                (self.api.XFlush)(self.display);
            }
        }
    }

    fn channel(pixel: u64, mask: u64) -> u8 {
        if mask == 0 {
            return 0;
        }
        let value = (pixel & mask) >> mask.trailing_zeros();
        let max = mask >> mask.trailing_zeros();
        ((value * 255 + max / 2) / max) as u8
    }

    pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
        if is_wayland_session() {
            return Ok(vec![WindowInfo {
                id: PORTAL_WINDOW_ID.into(),
                title: "Choose a window in the system screenshot dialog".into(),
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            }]);
        }
        let conn = DisplayConnection::open()?;
        let mut windows: Vec<_> = conn
            .client_windows()?
            .into_iter()
            .filter_map(|id| conn.info(id))
            .collect();
        windows.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        Ok(windows)
    }

    pub fn activate_window(window_id: &str) -> Result<WindowInfo, String> {
        if is_wayland_session() {
            return Err("Wayland does not allow ModuleLoom to activate arbitrary windows".into());
        }
        let id = u64::from_str_radix(window_id.trim_start_matches("0x"), 16)
            .map_err(|_| format!("Invalid X11 window ID: {window_id}"))?
            as xlib::Window;
        let conn = DisplayConnection::open()?;
        if !conn.client_windows()?.contains(&id) {
            return Err("Selected window is no longer open".into());
        }
        conn.activate(id);
        thread::sleep(Duration::from_millis(150));
        conn.info(id)
            .ok_or("The selected window is not visible".into())
    }

    pub fn capture_window(
        window_id: &str,
        inset: u32,
        destination: &Path,
    ) -> Result<WindowInfo, String> {
        if is_wayland_session() {
            if window_id != PORTAL_WINDOW_ID {
                return Err("Choose the portal window option on Wayland".into());
            }
            return capture_portal(inset, destination);
        }
        let id = u64::from_str_radix(window_id.trim_start_matches("0x"), 16)
            .map_err(|_| format!("Invalid X11 window ID: {window_id}"))?
            as xlib::Window;
        let conn = DisplayConnection::open()?;
        if !conn.client_windows()?.contains(&id) {
            return Err("Selected window is no longer open".into());
        }
        let state_before = conn.property(id, "_NET_WM_STATE");
        let above = conn.atom("_NET_WM_STATE_ABOVE");
        let already_above = state_before.as_ref().is_some_and(|(format, bytes)| {
            *format == 32
                && bytes
                    .chunks_exact(std::mem::size_of::<c_ulong>())
                    .any(|chunk| {
                        let mut native = [0u8; std::mem::size_of::<c_ulong>()];
                        native.copy_from_slice(chunk);
                        c_ulong::from_ne_bytes(native) == above
                    })
        });
        if !already_above {
            conn.set_above(id, true);
        }
        conn.activate(id);
        thread::sleep(Duration::from_millis(400));
        let result = capture_visible(&conn, id, inset, destination);
        if !already_above {
            conn.set_above(id, false);
        }
        result
    }

    fn capture_visible(
        conn: &DisplayConnection,
        id: xlib::Window,
        inset: u32,
        destination: &Path,
    ) -> Result<WindowInfo, String> {
        let info = conn.info(id).ok_or("The selected window is not visible")?;
        let margin = inset as i32;
        let x = info.x + margin;
        let y = info.y + margin;
        let width = info
            .width
            .checked_sub(inset.saturating_mul(2))
            .ok_or("Inset exceeds window width")?;
        let height = info
            .height
            .checked_sub(inset.saturating_mul(2))
            .ok_or("Inset exceeds window height")?;
        if width == 0 || height == 0 {
            return Err("Capture area is empty".into());
        }
        let screen = unsafe { (conn.api.XDefaultScreen)(conn.display) };
        let screen_width = unsafe { (conn.api.XDisplayWidth)(conn.display, screen) };
        let screen_height = unsafe { (conn.api.XDisplayHeight)(conn.display, screen) };
        if x < 0 || y < 0 || x + width as i32 > screen_width || y + height as i32 > screen_height {
            return Err("The entire window must be visible on the screen before capture".into());
        }
        let raw = unsafe {
            (conn.api.XGetImage)(
                conn.display,
                conn.root,
                x,
                y,
                width,
                height,
                !0,
                xlib::ZPixmap,
            )
        };
        if raw.is_null() {
            return Err("Could not capture the window pixels".into());
        }
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 3);
        let masks = unsafe {
            (
                (*raw).red_mask as u64,
                (*raw).green_mask as u64,
                (*raw).blue_mask as u64,
            )
        };
        for row in 0..height {
            for col in 0..width {
                let pixel = unsafe { (conn.api.XGetPixel)(raw, col as c_int, row as c_int) } as u64;
                pixels.extend([
                    channel(pixel, masks.0),
                    channel(pixel, masks.1),
                    channel(pixel, masks.2),
                ]);
            }
        }
        unsafe {
            (conn.api.XDestroyImage)(raw);
        }
        let picture = ImageBuffer::<Rgb<u8>, _>::from_raw(width, height, pixels)
            .ok_or("Invalid screenshot dimensions")?;
        picture
            .save(destination)
            .map_err(|error| error.to_string())?;
        Ok(info)
    }

    #[cfg(test)]
    mod tests {
        use super::channel;

        #[test]
        fn rgb_masks_decode_x11_pixel() {
            assert_eq!(channel(0x336699, 0xff0000), 0x33);
            assert_eq!(channel(0x336699, 0x00ff00), 0x66);
            assert_eq!(channel(0x336699, 0x0000ff), 0x99);
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::{activate_window, capture_window, list_windows};

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod native {
    use super::WindowInfo;
    use std::path::Path;
    use std::thread;
    use std::time::Duration;
    use xcap::Window;

    fn info(window: &Window) -> Result<WindowInfo, String> {
        Ok(WindowInfo {
            id: format!("0x{:x}", window.id().map_err(|error| error.to_string())?),
            title: window.title().map_err(|error| error.to_string())?,
            x: window.x().map_err(|error| error.to_string())?,
            y: window.y().map_err(|error| error.to_string())?,
            width: window.width().map_err(|error| error.to_string())?,
            height: window.height().map_err(|error| error.to_string())?,
        })
    }

    pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
        let mut windows = Vec::new();
        for window in Window::all().map_err(|error| error.to_string())? {
            if window.is_minimized().unwrap_or(true) {
                continue;
            }
            if let Ok(item) = info(&window) {
                if !item.title.trim().is_empty() && item.width > 0 && item.height > 0 {
                    windows.push(item);
                }
            }
        }
        windows.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        Ok(windows)
    }

    pub fn activate_window(window_id: &str) -> Result<WindowInfo, String> {
        let id = u32::from_str_radix(window_id.trim_start_matches("0x"), 16)
            .map_err(|_| format!("Invalid window ID: {window_id}"))?;
        let window = Window::all()
            .map_err(|error| error.to_string())?
            .into_iter()
            .find(|item| item.id().is_ok_and(|candidate| candidate == id))
            .ok_or("Selected window is no longer open")?;
        #[cfg(target_os = "windows")]
        {
            #[link(name = "user32")]
            unsafe extern "system" {
                fn SetForegroundWindow(window: isize) -> i32;
            }
            // xcap exposes the low 32 bits of HWND; Windows sign-extends them on 64-bit systems.
            if unsafe { SetForegroundWindow((id as i32) as isize) } == 0 {
                return Err("Windows denied activation of the selected window".into());
            }
        }
        #[cfg(target_os = "macos")]
        {
            let pid = window.pid().map_err(|error| error.to_string())?;
            let script = format!("tell application \"System Events\" to set frontmost of (first process whose unix id is {pid}) to true");
            let output = std::process::Command::new("osascript")
                .args(["-e", &script])
                .output()
                .map_err(|error| format!("Could not activate window: {error}"))?;
            if !output.status.success() {
                return Err(format!(
                    "Could not activate window: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        }
        thread::sleep(Duration::from_millis(150));
        info(&window)
    }

    pub fn capture_window(
        window_id: &str,
        inset: u32,
        destination: &Path,
    ) -> Result<WindowInfo, String> {
        let id = u32::from_str_radix(window_id.trim_start_matches("0x"), 16)
            .map_err(|_| format!("Invalid window ID: {window_id}"))?;
        let window = Window::all()
            .map_err(|error| error.to_string())?
            .into_iter()
            .find(|item| item.id().is_ok_and(|candidate| candidate == id))
            .ok_or("Selected window is no longer open")?;
        if window.is_minimized().unwrap_or(true) {
            return Err("Selected window is minimized".into());
        }
        let details = info(&window)?;
        let image = window
            .capture_image()
            .map_err(|error| format!("Could not capture window: {error}"))?;
        let crop = inset.checked_mul(2).ok_or("Inset is too large")?;
        let width = image
            .width()
            .checked_sub(crop)
            .ok_or("Inset exceeds captured image width")?;
        let height = image
            .height()
            .checked_sub(crop)
            .ok_or("Inset exceeds captured image height")?;
        if width == 0 || height == 0 {
            return Err("Capture area is empty".into());
        }
        let cropped = image::imageops::crop_imm(&image, inset, inset, width, height).to_image();
        cropped
            .save(destination)
            .map_err(|error| error.to_string())?;
        Ok(details)
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub use native::{activate_window, capture_window, list_windows};

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    Err("Window capture is unsupported on this platform".into())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub fn capture_window(
    _window_id: &str,
    _inset: u32,
    _destination: &std::path::Path,
) -> Result<WindowInfo, String> {
    Err("Window capture is unsupported on this platform".into())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub fn activate_window(_window_id: &str) -> Result<WindowInfo, String> {
    Err("Window activation is unsupported on this platform".into())
}
