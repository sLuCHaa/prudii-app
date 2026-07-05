import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../stores/appStore";

// Exact-match tracking parameters (ad/email click identifiers)
const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "twclid",
  "yclid", "igshid", "mc_cid", "mc_eid", "mkt_tok", "_hsenc", "_hsmi",
  "oly_anon_id", "oly_enc_id", "vero_id", "vero_conv", "ck_subscriber_id",
  "li_fat_id",
]);

// Remove known tracking query parameters (utm_* prefix + exact matches).
// Only touches http(s) URLs; anything unparseable is returned unchanged.
export function stripTrackingParams(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;

  const toDelete: string[] = [];
  parsed.searchParams.forEach((_value, key) => {
    const k = key.toLowerCase();
    if (k.startsWith("utm_") || TRACKING_PARAMS.has(k)) toDelete.push(key);
  });
  // Untouched URLs are returned verbatim — toString() would re-normalize them.
  if (toDelete.length === 0) return url;
  for (const key of toDelete) parsed.searchParams.delete(key);
  return parsed.toString();
}

export function cleanMailUrl(href: string): string {
  if (!useAppStore.getState().appSettings.strip_tracking_params) return href;
  return stripTrackingParams(href);
}

// Open a link that originated from email content.
export function openMailUrl(href: string): Promise<void> {
  return openUrl(cleanMailUrl(href));
}
