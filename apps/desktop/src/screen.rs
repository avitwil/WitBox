//! Primary-monitor geometry and capture (real pixels). X11 on Linux, GDI on Windows.

pub struct Geometry {
    /// Origin of the primary monitor in virtual-screen coordinates.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub struct Capture {
    pub width: u32,
    pub height: u32,
    /// Tightly packed RGB8, `width * height * 3` bytes.
    pub rgb: Vec<u8>,
}

#[cfg(target_os = "linux")]
pub use linux::{available, capture, geometry};
#[cfg(windows)]
pub use windows_impl::{available, capture, geometry};

#[cfg(target_os = "linux")]
mod linux {
    use super::{Capture, Geometry};
    use x11rb::{
        connection::Connection,
        protocol::{
            randr::ConnectionExt as _,
            xproto::{ConnectionExt as _, ImageFormat, ImageOrder},
        },
        rust_connection::RustConnection,
    };

    /// Remote control needs a real X11 session; on Wayland XWayland would only give black
    /// screenshots and input that reaches X clients only, so report "not available".
    pub fn available() -> bool {
        let wayland = std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.eq_ignore_ascii_case("wayland"))
            || std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty());
        if wayland {
            return false;
        }
        x11rb::connect(None).is_ok()
    }

    fn connect() -> Result<(RustConnection, usize), String> {
        x11rb::connect(None).map_err(|e| format!("cannot connect to the X server: {e}"))
    }

    fn primary(conn: &RustConnection, screen_num: usize) -> Result<Geometry, String> {
        let screen = &conn.setup().roots[screen_num];
        let whole = Geometry {
            x: 0,
            y: 0,
            width: screen.width_in_pixels as u32,
            height: screen.height_in_pixels as u32,
        };
        // RandR: primary output's CRTC, else the first active CRTC, else the whole root.
        let crtc_geometry = |crtc: u32| -> Option<Geometry> {
            if crtc == 0 {
                return None;
            }
            let info = conn.randr_get_crtc_info(crtc, 0).ok()?.reply().ok()?;
            (info.width > 0 && info.height > 0).then(|| Geometry {
                x: info.x as i32,
                y: info.y as i32,
                width: info.width as u32,
                height: info.height as u32,
            })
        };
        let from_randr = || -> Option<Geometry> {
            let primary = conn.randr_get_output_primary(screen.root).ok()?.reply().ok()?;
            if primary.output != 0 {
                let out = conn.randr_get_output_info(primary.output, 0).ok()?.reply().ok()?;
                if let Some(g) = crtc_geometry(out.crtc) {
                    return Some(g);
                }
            }
            let res = conn
                .randr_get_screen_resources_current(screen.root)
                .ok()?
                .reply()
                .ok()?;
            res.crtcs.iter().find_map(|c| crtc_geometry(*c))
        };
        Ok(from_randr().unwrap_or(whole))
    }

    pub fn geometry() -> Result<Geometry, String> {
        let (conn, screen_num) = connect()?;
        primary(&conn, screen_num)
    }

    pub fn capture() -> Result<Capture, String> {
        let (conn, screen_num) = connect()?;
        let g = primary(&conn, screen_num)?;
        let setup = conn.setup();
        let screen = &setup.roots[screen_num];
        let reply = conn
            .get_image(
                ImageFormat::Z_PIXMAP,
                screen.root,
                g.x as i16,
                g.y as i16,
                g.width as u16,
                g.height as u16,
                !0,
            )
            .map_err(|e| format!("GetImage failed: {e}"))?
            .reply()
            .map_err(|e| format!("GetImage failed: {e}"))?;

        let format = setup
            .pixmap_formats
            .iter()
            .find(|f| f.depth == reply.depth)
            .ok_or("unknown pixmap format")?;
        let bytes_pp = (format.bits_per_pixel / 8) as usize;
        if bytes_pp != 3 && bytes_pp != 4 {
            return Err(format!("unsupported screen depth ({} bpp)", format.bits_per_pixel));
        }
        let (w, h) = (g.width as usize, g.height as usize);
        let pad = (format.scanline_pad / 8).max(1) as usize;
        let stride = (w * bytes_pp).div_ceil(pad) * pad;
        if reply.data.len() < stride * h {
            return Err("short image data from the X server".into());
        }
        // TrueColor 24/32-bit visuals: pixel = 0x00RRGGBB in the server's byte order.
        let visual = screen
            .allowed_depths
            .iter()
            .flat_map(|d| d.visuals.iter())
            .find(|v| v.visual_id == reply.visual);
        let (rmask, gmask, bmask) = visual
            .map(|v| (v.red_mask, v.green_mask, v.blue_mask))
            .unwrap_or((0xff0000, 0x00ff00, 0x0000ff));
        let shift = |mask: u32| mask.trailing_zeros();
        let (rs, gs, bs) = (shift(rmask), shift(gmask), shift(bmask));
        let lsb_first = setup.image_byte_order == ImageOrder::LSB_FIRST;

        let mut rgb = Vec::with_capacity(w * h * 3);
        for row in reply.data.chunks_exact(stride).take(h) {
            for px in row[..w * bytes_pp].chunks_exact(bytes_pp) {
                let v = if lsb_first {
                    px.iter().rev().fold(0u32, |acc, b| (acc << 8) | *b as u32)
                } else {
                    px.iter().fold(0u32, |acc, b| (acc << 8) | *b as u32)
                };
                rgb.push((v >> rs) as u8);
                rgb.push((v >> gs) as u8);
                rgb.push((v >> bs) as u8);
            }
        }
        Ok(Capture {
            width: g.width,
            height: g.height,
            rgb,
        })
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::{Capture, Geometry};
    use windows::Win32::{
        Graphics::Gdi::{
            BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
            GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
            DIB_RGB_COLORS, SRCCOPY,
        },
        UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN},
    };

    pub fn available() -> bool {
        true
    }

    /// The primary monitor always starts at (0,0) of the virtual screen on Windows. The
    /// process is per-monitor DPI aware (manifest), so these are physical pixels.
    pub fn geometry() -> Result<Geometry, String> {
        let (w, h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
        if w <= 0 || h <= 0 {
            return Err("cannot read the screen size".into());
        }
        Ok(Geometry {
            x: 0,
            y: 0,
            width: w as u32,
            height: h as u32,
        })
    }

    pub fn capture() -> Result<Capture, String> {
        let g = geometry()?;
        let (w, h) = (g.width as i32, g.height as i32);
        let mut bgra = vec![0u8; g.width as usize * g.height as usize * 4];
        unsafe {
            let screen_dc = GetDC(None);
            if screen_dc.is_invalid() {
                return Err("GetDC failed".into());
            }
            let mem_dc = CreateCompatibleDC(Some(screen_dc));
            let bitmap = CreateCompatibleBitmap(screen_dc, w, h);
            let mut result = Err("screen capture failed".to_string());
            if !mem_dc.is_invalid() && !bitmap.is_invalid() {
                let old = SelectObject(mem_dc, bitmap.into());
                let blt = BitBlt(mem_dc, 0, 0, w, h, Some(screen_dc), 0, 0, SRCCOPY | CAPTUREBLT);
                // the bitmap must not be selected into a DC when GetDIBits is called
                SelectObject(mem_dc, old);
                match blt {
                    Err(e) => result = Err(format!("BitBlt failed: {e}")),
                    Ok(()) => {
                        let mut info = BITMAPINFO {
                            bmiHeader: BITMAPINFOHEADER {
                                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                                biWidth: w,
                                biHeight: -h, // top-down
                                biPlanes: 1,
                                biBitCount: 32,
                                biCompression: BI_RGB.0,
                                ..Default::default()
                            },
                            ..Default::default()
                        };
                        let lines = GetDIBits(
                            mem_dc,
                            bitmap,
                            0,
                            h as u32,
                            Some(bgra.as_mut_ptr().cast()),
                            &mut info,
                            DIB_RGB_COLORS,
                        );
                        result = if lines == h {
                            Ok(())
                        } else {
                            Err("GetDIBits failed".to_string())
                        };
                    }
                }
            }
            if !bitmap.is_invalid() {
                let _ = DeleteObject(bitmap.into());
            }
            if !mem_dc.is_invalid() {
                let _ = DeleteDC(mem_dc);
            }
            ReleaseDC(None, screen_dc);
            result?;
        }
        let mut rgb = Vec::with_capacity(g.width as usize * g.height as usize * 3);
        for px in bgra.chunks_exact(4) {
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
        Ok(Capture {
            width: g.width,
            height: g.height,
            rgb,
        })
    }
}
