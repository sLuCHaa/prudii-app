import { describe, it, expect } from "vitest";
import { bannerView } from "./updateBanner";

describe("bannerView", () => {
  it("offers the update with version and subtitle when idle", () => {
    expect(bannerView("idle", 0)).toEqual({ tone: "accent", titleKey: "updateBanner.title", pct: null, showDetails: true, actions: "offer" });
  });

  it("shows clamped progress without actions while downloading", () => {
    expect(bannerView("downloading", 42)).toEqual({ tone: "accent", titleKey: "updateBanner.loading", pct: 42, showDetails: false, actions: "none" });
    expect(bannerView("downloading", 140).pct).toBe(100);
    expect(bannerView("downloading", -5).pct).toBe(0);
  });

  it("keeps the line full while verifying", () => {
    expect(bannerView("verifying", 100)).toEqual({ tone: "accent", titleKey: "updateBanner.verifying", pct: 100, showDetails: false, actions: "none" });
  });

  it("confirms before the restart", () => {
    expect(bannerView("ready", 100)).toEqual({ tone: "success", titleKey: "updateBanner.restarting", pct: null, showDetails: false, actions: "none" });
  });

  it("offers a retry after an error", () => {
    expect(bannerView("error", 30)).toEqual({ tone: "danger", titleKey: "settings.update.checksumError", pct: null, showDetails: false, actions: "retry" });
  });
});
