//! Windows-only WebView2 tweaks that wry does not expose: User-Agent suffix, HTML
//! fullscreen (video) → window fullscreen, load-failure reporting.

use std::sync::Arc;

use webview2_com::{
    take_pwstr, ContainsFullScreenElementChangedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings2, COREWEBVIEW2_WEB_ERROR_STATUS,
        COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT,
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT,
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED,
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID,
        COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET,
        COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED,
        COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED,
        COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE, COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT,
    },
    NavigationCompletedEventHandler,
};
use windows::core::{Interface, BOOL, HSTRING, PWSTR};
use wry::WebViewExtWindows;

use crate::app::{Shared, UserEvent, PLATFORM, VERSION};

fn describe(status: COREWEBVIEW2_WEB_ERROR_STATUS) -> Option<&'static str> {
    Some(match status {
        COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT => "cannot connect to the server",
        COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED => "host name not resolved",
        COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE => "server unreachable",
        COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT => "connection timed out",
        COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED => "network disconnected",
        COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET => "connection reset",
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT
        | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED
        | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID => "TLS certificate problem",
        // aborted / cancelled navigations (downloads, external links) are not failures
        _ => return None,
    })
}

pub fn setup(webview: &wry::WebView, shared: Arc<Shared>) -> windows::core::Result<()> {
    let core = webview.webview();
    unsafe {
        // "<default UA> WitBoxApp/<version> (windows)"
        let settings: ICoreWebView2Settings2 = core.Settings()?.cast()?;
        let mut ua = PWSTR::null();
        settings.UserAgent(&mut ua)?;
        let base = take_pwstr(ua);
        if !base.contains("WitBoxApp/") {
            settings.SetUserAgent(&HSTRING::from(format!(
                "{base} WitBoxApp/{VERSION} ({PLATFORM})"
            )))?;
        }

        let mut token = 0i64;
        let s = shared.clone();
        core.add_ContainsFullScreenElementChanged(
            &ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(sender) = sender {
                    let mut full = BOOL::default();
                    sender.ContainsFullScreenElement(&mut full)?;
                    s.send(UserEvent::Fullscreen(full.as_bool()));
                }
                Ok(())
            })),
            &mut token,
        )?;

        let s = shared;
        core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut success = BOOL::default();
                args.IsSuccess(&mut success)?;
                if !success.as_bool() {
                    let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                    args.WebErrorStatus(&mut status)?;
                    if let Some(why) = describe(status) {
                        crate::log!("webview: navigation failed: {why}");
                        s.send(UserEvent::LoadFailed(why.to_string()));
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}
