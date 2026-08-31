/** True when running inside the macOS WebView (native traffic lights present). */
export const isMacOS = navigator.userAgent.includes("Mac");

/** True on Windows (WebView2) — gates the native caption integration. */
export const isWindows = navigator.userAgent.includes("Windows");
