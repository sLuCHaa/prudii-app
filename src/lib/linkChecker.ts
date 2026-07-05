export type LinkWarningType =
  | "ip_address"
  | "punycode"
  | "typosquatting"
  | "excessive_subdomains"
  | "suspicious_tld"
  | "url_shortener"
  | "redirect_param"
  | "data_exfil";

export interface LinkWarning {
  type: LinkWarningType;
  detail: string;
}

export interface LinkCheckResult {
  safe: boolean;
  warnings: LinkWarning[];
}

const SUSPICIOUS_TLDS = new Set([
  ".tk", ".ml", ".ga", ".cf", ".gq", ".xyz", ".top",
  ".buzz", ".club", ".icu", ".click", ".link", ".surf", ".work",
]);

const URL_SHORTENERS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly",
  "is.gd", "buff.ly", "cutt.ly", "short.io", "tiny.cc", "lnkd.in",
]);

const BRAND_DOMAINS: Record<string, string[]> = {
  google: ["google.com", "google.co", "googleapis.com", "gstatic.com", "youtube.com"],
  paypal: ["paypal.com", "paypal.me"],
  microsoft: ["microsoft.com", "live.com", "outlook.com", "office.com", "office365.com", "microsoftonline.com"],
  amazon: ["amazon.com", "amazon.co", "amazonaws.com", "amzn.to"],
  apple: ["apple.com", "icloud.com"],
  facebook: ["facebook.com", "fb.com", "meta.com"],
  netflix: ["netflix.com"],
  bank: [],
  signin: [],
  login: [],
};

const REDIRECT_PARAMS = new Set([
  "url", "redirect", "next", "goto", "return_to", "target", "dest",
]);

function getHostname(href: string): string | null {
  try {
    return new URL(href).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function checkLink(href: string): LinkCheckResult {
  const warnings: LinkWarning[] = [];

  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return { safe: true, warnings: [] };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[")) {
    warnings.push({ type: "ip_address", detail: hostname });
  }

  if (hostname.startsWith("xn--") || hostname.split(".").some((p) => p.startsWith("xn--"))) {
    warnings.push({ type: "punycode", detail: hostname });
  }

  // Typosquatting — hostname contains brand keyword but isn't the real domain
  for (const [brand, legit] of Object.entries(BRAND_DOMAINS)) {
    if (hostname.includes(brand)) {
      const isLegit = legit.some(
        (d) => hostname === d || hostname.endsWith("." + d),
      );
      if (!isLegit) {
        warnings.push({ type: "typosquatting", detail: `${brand} → ${hostname}` });
        break;
      }
    }
  }

  const dotCount = hostname.split(".").length - 1;
  if (dotCount > 3) {
    warnings.push({ type: "excessive_subdomains", detail: `${dotCount} levels: ${hostname}` });
  }

  const tld = "." + (hostname.split(".").pop() || "");
  if (tld !== "." && SUSPICIOUS_TLDS.has(tld)) {
    warnings.push({ type: "suspicious_tld", detail: tld });
  }

  // URL shortener (warning but safe stays true)
  if (URL_SHORTENERS.has(hostname)) {
    warnings.push({ type: "url_shortener", detail: hostname });
    return { safe: true, warnings };
  }

  for (const [key, value] of parsed.searchParams) {
    if (REDIRECT_PARAMS.has(key.toLowerCase()) && /^https?:\/\//i.test(value)) {
      warnings.push({ type: "redirect_param", detail: `${key}=${value.slice(0, 60)}...` });
      break;
    }
  }

  if (parsed.search.length > 500) {
    warnings.push({ type: "data_exfil", detail: `${parsed.search.length} chars in query` });
  }

  const safe = warnings.length === 0;
  return { safe, warnings };
}
