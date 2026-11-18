//! WitBox addition: runtime-resolved WebView2 loader.
//!
//! The upstream crate imports `WebView2Loader.dll` on GNU targets, which would force
//! shipping that DLL next to the exe. Here the official loader DLL (x64) is embedded in
//! the binary, written once to `%LOCALAPPDATA%\WitBox\runtime\` and loaded with
//! `LoadLibraryW`; the five loader entry points below forward to it.

#![allow(non_snake_case, clippy::missing_safety_doc)]

use core::ffi::c_void;
use std::{os::windows::ffi::OsStrExt, path::PathBuf, sync::OnceLock};
use windows_core::{HRESULT, PCWSTR, PWSTR};

#[cfg(target_arch = "x86_64")]
static LOADER_DLL: &[u8] = include_bytes!("../x64/WebView2Loader.dll");

// HRESULT_FROM_WIN32(ERROR_MOD_NOT_FOUND)
const E_MOD_NOT_FOUND: HRESULT = HRESULT(0x8007007Eu32 as i32);

extern "system" {
    fn LoadLibraryW(name: *const u16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
}

fn candidate_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(p) = std::env::var_os("LOCALAPPDATA") {
        v.push(PathBuf::from(p).join("WitBox").join("runtime"));
    }
    v.push(std::env::temp_dir().join("WitBox-runtime"));
    v
}

fn extract() -> Option<PathBuf> {
    for dir in candidate_dirs() {
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }
        let path = dir.join("WebView2Loader.dll");
        let up_to_date = std::fs::read(&path).map(|b| b == LOADER_DLL).unwrap_or(false);
        if up_to_date || std::fs::write(&path, LOADER_DLL).is_ok() {
            return Some(path);
        }
    }
    None
}

fn module() -> *mut c_void {
    static MODULE: OnceLock<usize> = OnceLock::new();
    *MODULE.get_or_init(|| {
        let Some(path) = extract() else { return 0 };
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe { LoadLibraryW(wide.as_ptr()) as usize }
    }) as *mut c_void
}

/// `name` must be NUL-terminated.
fn proc_addr(name: &'static [u8]) -> *mut c_void {
    let m = module();
    if m.is_null() {
        return core::ptr::null_mut();
    }
    unsafe { GetProcAddress(m, name.as_ptr()) }
}

#[no_mangle]
pub unsafe extern "system" fn CompareBrowserVersions(
    version1: PCWSTR,
    version2: PCWSTR,
    result: *mut i32,
) -> HRESULT {
    let p = proc_addr(b"CompareBrowserVersions\0");
    if p.is_null() {
        return E_MOD_NOT_FOUND;
    }
    let f: unsafe extern "system" fn(PCWSTR, PCWSTR, *mut i32) -> HRESULT = core::mem::transmute(p);
    f(version1, version2, result)
}

#[no_mangle]
pub unsafe extern "system" fn CreateCoreWebView2Environment(
    environmentcreatedhandler: *mut c_void,
) -> HRESULT {
    let p = proc_addr(b"CreateCoreWebView2Environment\0");
    if p.is_null() {
        return E_MOD_NOT_FOUND;
    }
    let f: unsafe extern "system" fn(*mut c_void) -> HRESULT = core::mem::transmute(p);
    f(environmentcreatedhandler)
}

#[no_mangle]
pub unsafe extern "system" fn CreateCoreWebView2EnvironmentWithOptions(
    browserexecutablefolder: PCWSTR,
    userdatafolder: PCWSTR,
    environmentoptions: *mut c_void,
    environmentcreatedhandler: *mut c_void,
) -> HRESULT {
    let p = proc_addr(b"CreateCoreWebView2EnvironmentWithOptions\0");
    if p.is_null() {
        return E_MOD_NOT_FOUND;
    }
    let f: unsafe extern "system" fn(PCWSTR, PCWSTR, *mut c_void, *mut c_void) -> HRESULT =
        core::mem::transmute(p);
    f(
        browserexecutablefolder,
        userdatafolder,
        environmentoptions,
        environmentcreatedhandler,
    )
}

#[no_mangle]
pub unsafe extern "system" fn GetAvailableCoreWebView2BrowserVersionString(
    browserexecutablefolder: PCWSTR,
    versioninfo: *mut PWSTR,
) -> HRESULT {
    let p = proc_addr(b"GetAvailableCoreWebView2BrowserVersionString\0");
    if p.is_null() {
        return E_MOD_NOT_FOUND;
    }
    let f: unsafe extern "system" fn(PCWSTR, *mut PWSTR) -> HRESULT = core::mem::transmute(p);
    f(browserexecutablefolder, versioninfo)
}

#[no_mangle]
pub unsafe extern "system" fn GetAvailableCoreWebView2BrowserVersionStringWithOptions(
    browserexecutablefolder: PCWSTR,
    environmentoptions: *mut c_void,
    versioninfo: *mut PWSTR,
) -> HRESULT {
    let p = proc_addr(b"GetAvailableCoreWebView2BrowserVersionStringWithOptions\0");
    if p.is_null() {
        return E_MOD_NOT_FOUND;
    }
    let f: unsafe extern "system" fn(PCWSTR, *mut c_void, *mut PWSTR) -> HRESULT =
        core::mem::transmute(p);
    f(browserexecutablefolder, environmentoptions, versioninfo)
}
