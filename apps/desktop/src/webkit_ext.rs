//! Linux-only WebKitGTK tweaks that wry does not expose: media settings, User-Agent
//! suffix, main-frame-aware external-link policy, load-failure reporting.

use std::sync::Arc;

use gtk::glib::prelude::*;
use webkit2gtk::{
    NavigationPolicyDecision, NavigationPolicyDecisionExt, NavigationType, PolicyDecisionExt, PolicyDecisionType, SettingsExt,
    WebViewExt,
};
use wry::WebViewExtUnix;

use crate::{
    app::{Shared, UserEvent, PLATFORM, VERSION},
    nav_decision, NavDecision,
};

pub fn setup(webview: &wry::WebView, shared: Arc<Shared>) {
    let wv = webview.webview();

    if let Some(settings) = WebViewExt::settings(&wv) {
        // microphone / camera (getUserMedia), media playback, fullscreen video
        settings.set_enable_media_stream(true);
        settings.set_enable_mediasource(true);
        settings.set_enable_media(true);
        settings.set_enable_webrtc(true);
        settings.set_enable_fullscreen(true);
        settings.set_media_playback_requires_user_gesture(false);
        settings.set_enable_html5_local_storage(true);
        settings.set_javascript_can_open_windows_automatically(true);
        // "<default UA> WitBoxApp/<version> (linux)"
        let base = settings.user_agent().map(|s| s.to_string()).unwrap_or_default();
        if !base.contains("WitBoxApp/") {
            settings.set_user_agent(Some(&format!("{base} WitBoxApp/{VERSION} ({PLATFORM})")));
        }
    }

    // External links open in the system browser. WebKitGTK reports sub-frame navigations
    // through the same signal without saying which frame they belong to, so only
    // user-initiated navigations (link clicks) are redirected; iframes and redirects that
    // the page itself triggers are left alone.
    let s = shared.clone();
    wv.connect_decide_policy(move |_wv, decision, kind| {
        if kind != PolicyDecisionType::NavigationAction {
            return false; // new windows → "create" handler; responses → default (downloads)
        }
        let Some(nav) = decision.dynamic_cast_ref::<NavigationPolicyDecision>() else {
            return false;
        };
        let Some(action) = nav.navigation_action() else {
            return false;
        };
        let Some(uri) = action
            .request()
            .and_then(|r| webkit2gtk::URIRequestExt::uri(&r))
            .map(|u| u.to_string())
        else {
            return false;
        };
        let user_initiated =
            action.is_user_gesture() || action.navigation_type() == NavigationType::LinkClicked;
        match nav_decision(&uri, &s.server_url()) {
            NavDecision::Allow => false,
            NavDecision::External if user_initiated => {
                crate::platform::open_external(&uri);
                decision.ignore();
                true
            }
            NavDecision::External => false,
            NavDecision::Block => {
                decision.ignore();
                true
            }
        }
    });

    let s = shared.clone();
    wv.connect_load_failed(move |_wv, _event, uri, error| {
        // cancellations, policy interruptions (downloads, external links) are not failures
        if error.matches(webkit2gtk::NetworkError::Cancelled)
            || error.is::<webkit2gtk::PolicyError>()
            || error.is::<webkit2gtk::DownloadError>()
        {
            return false;
        }
        crate::log!("webview: load failed for {uri}: {error}");
        s.send(UserEvent::LoadFailed(error.to_string()));
        true
    });

    wv.connect_load_failed_with_tls_errors(move |_wv, uri, _cert, flags| {
        crate::log!("webview: TLS error for {uri}: {flags:?}");
        shared.send(UserEvent::LoadFailed(format!(
            "TLS certificate problem ({flags:?})"
        )));
        true
    });
}
