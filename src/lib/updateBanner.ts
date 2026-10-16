export type UpdatePhase = "idle" | "downloading" | "verifying" | "ready" | "error";

export interface BannerView {
  tone: "accent" | "success" | "danger";
  titleKey: string;
  /** Width of the progress line in percent; null hides it. */
  pct: number | null;
  /** Version chip and subtitle, only while the update is on offer. */
  showDetails: boolean;
  actions: "offer" | "retry" | "none";
}

export function bannerView(phase: UpdatePhase, pct: number): BannerView {
  switch (phase) {
    case "downloading":
      return { tone: "accent", titleKey: "updateBanner.loading", pct: Math.min(100, Math.max(0, pct)), showDetails: false, actions: "none" };
    case "verifying":
      return { tone: "accent", titleKey: "updateBanner.verifying", pct: 100, showDetails: false, actions: "none" };
    case "ready":
      return { tone: "success", titleKey: "updateBanner.restarting", pct: null, showDetails: false, actions: "none" };
    case "error":
      return { tone: "danger", titleKey: "settings.update.checksumError", pct: null, showDetails: false, actions: "retry" };
    default:
      return { tone: "accent", titleKey: "updateBanner.title", pct: null, showDetails: true, actions: "offer" };
  }
}
