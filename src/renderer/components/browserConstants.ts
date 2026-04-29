// Sentinel URL for the empty browser ("new tab") state.
//
// Why a `data:` URL instead of `about:blank`: wry-0.54's `url_from_webview`
// unwraps WKWebView's `URL` property, which is nil for a freshly-created
// about:blank webview before its first load resolves. tao's
// `stop_app_on_panic` then escalates the runtime-thread panic to a process
// crash. A `data:` URL is its own URL — WKWebView's URL is populated the
// moment we hand it to `add_child`, so no internal accessor (ours, Tauri's,
// or wry's) can land in the nil-unwrap window.
//
// Lives in its own module so Chat.tsx can import the constant without
// statically pulling BrowserPanel into its chunk and defeating the
// `React.lazy()` split.
export const BROWSER_BLANK_URL = 'data:text/html;charset=utf-8,%3Chtml%3E%3C%2Fhtml%3E';
