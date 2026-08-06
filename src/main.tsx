import "./lib/i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import gsap from "gsap";
import App from "./App";
import "overlayscrollbars/overlayscrollbars.css";
import "./index.css";
import synonym400 from "./assets/fonts/synonym/synonym-400.woff2?url";
import synonym500 from "./assets/fonts/synonym/synonym-500.woff2?url";
import amulya700 from "./assets/fonts/amulya/amulya-700.woff2?url";

// Pause ALL GSAP animations when the window is hidden/minimized to save CPU/GPU.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    gsap.globalTimeline.pause();
  } else {
    gsap.globalTimeline.resume();
  }
});

// Fetch the core text faces before first paint so cold starts don't flash
// the fallback font (font-display: swap).
for (const href of [synonym400, synonym500, amulya700]) {
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "font";
  link.type = "font/woff2";
  link.crossOrigin = "anonymous";
  link.href = href;
  document.head.appendChild(link);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
