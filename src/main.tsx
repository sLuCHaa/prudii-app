import "./lib/i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import gsap from "gsap";
import App from "./App";
import "overlayscrollbars/overlayscrollbars.css";
import "./index.css";

// Pause ALL GSAP animations when the window is hidden/minimized to save CPU/GPU.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    gsap.globalTimeline.pause();
  } else {
    gsap.globalTimeline.resume();
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
