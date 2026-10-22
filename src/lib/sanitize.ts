import DOMPurify from "dompurify";

// Escape plain text for safe embedding in HTML (prevents XSS in subject, names, etc.)
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return text.replace(/[&<>"']/g, (c) => map[c]);
}

export function plainTextParagraph(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
}

// Sanitize user-authored signature HTML: strips <script>, event handlers and
// javascript: URLs while keeping normal formatting, links and images. Applied
// before signature HTML is parsed so pasted markup can't inject anything.
export function sanitizeSignatureHtml(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

// A reopened draft keeps its logo as a local file until the images are inlined, so this variant lets `file:` through on image sources only.
const keepLocalImageSrc = (node: Element, data: { attrName: string; attrValue: string; forceKeepAttr: boolean | undefined }) => {
  if (node.nodeName === "IMG" && data.attrName === "src" && /^file:/i.test(data.attrValue.trim())) data.forceKeepAttr = true;
};

// The block is live DOM inside the compose window, so nothing that styles the page, submits or plays may pass.
const SIGNATURE_TAGS = [
  "div", "span", "p", "br", "hr",
  "b", "i", "u", "s", "em", "strong", "small", "sub", "sup", "mark",
  "del", "ins", "abbr", "cite", "code", "pre", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "img", "picture", "figure", "figcaption",
  "a",
  "center", "section", "article", "header", "footer", "nav", "main", "aside",
  "font", "wbr",
];

const SIGNATURE_ATTRS = [
  "style", "class", "width", "height", "align", "valign", "bgcolor", "border", "cellpadding", "cellspacing",
  "colspan", "rowspan", "href", "src", "alt", "title", "target", "rel", "color", "face", "size", "dir", "lang",
  "nowrap", "clear", "span", "start", "type", "noshade",
];

export function sanitizeSignatureBlockHtml(html: string): string {
  DOMPurify.addHook("uponSanitizeAttribute", keepLocalImageSrc);
  try {
    return DOMPurify.sanitize(html, { ALLOWED_TAGS: SIGNATURE_TAGS, ALLOWED_ATTR: SIGNATURE_ATTRS, ALLOW_DATA_ATTR: false });
  } finally {
    DOMPurify.removeHook("uponSanitizeAttribute", keepLocalImageSrc);
  }
}

// `removed` counts elements and attributes DOMPurify dropped in this very call.
export function sanitizeSignatureHtmlReport(html: string): { html: string; removed: number } {
  const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  return { html: clean, removed: DOMPurify.removed.length };
}

export interface TrackerInfo {
  domain: string;
  type: "pixel" | "tracking_domain" | "hidden";
  src: string;
}

export interface SanitizeResult {
  html: string;
  trackers: TrackerInfo[];
}

const KNOWN_TRACKER_DOMAINS = new Set([
  // Email platforms
  "sendgrid.net", "mailchimp.com", "list-manage.com", "mailgun.org",
  "amazonses.com", "postmarkapp.com", "sparkpostmail.com", "constantcontact.com",
  "brevo.com", "hubspot.com", "campaign-archive.com", "mailtrack.io",
  "yesware.com", "bananatag.com", "cirrusinsight.com", "boomeranggmail.com",
  "streak.com", "mixmax.com", "superhuman.com", "getnotify.com", "sendergen.com",
  "mandrillapp.com", "exacttarget.com", "sailthru.com", "returnpath.net",
  "litmus.com", "emailtracking.com", "cmail19.com", "cmail20.com",
  "createsend1.com", "createsend2.com", "mcsv.net", "mcdlv.net",
  "klclick.com", "klaviyo.com", "dripemail2.com", "convertkit-mail.com",
  "activecampaign.com", "aweber.com", "getresponse.com", "infusionsoft.com",
  "keap-link.com", "ctctcdn.com", "emltrk.com", "sendinblue.com",
  "mailjet.com", "mailerlite.com", "benchmarkemail.com",
  // Analytics
  "google-analytics.com", "doubleclick.net", "facebook.com", "linkedin.com",
  "bat.bing.com", "analytics.twitter.com", "px.ads.linkedin.com",
]);

const TRACKING_PREFIXES = [
  "pixel.", "track.", "open.", "trk.", "click.", "beacon.",
  "img.", "t.", "e.", "o.",
];

function getDomain(src: string): string {
  try {
    return new URL(src).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isTrackerDomain(domain: string): boolean {
  if (KNOWN_TRACKER_DOMAINS.has(domain)) return true;
  // Check parent domains (e.g. x.sendgrid.net → sendgrid.net)
  const parts = domain.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (KNOWN_TRACKER_DOMAINS.has(parts.slice(i).join("."))) return true;
  }
  for (const prefix of TRACKING_PREFIXES) {
    if (domain.startsWith(prefix)) return true;
  }
  return false;
}

function isPixelImage(img: Element): boolean {
  const w = img.getAttribute("width");
  const h = img.getAttribute("height");
  if (w && h) {
    const wn = parseInt(w, 10);
    const hn = parseInt(h, 10);
    if (wn <= 1 && hn <= 1) return true;
  }
  const style = (img.getAttribute("style") || "").toLowerCase();
  if (/width\s*:\s*[01](px)?\b/.test(style) && /height\s*:\s*[01](px)?\b/.test(style)) return true;
  return false;
}

function isHiddenImage(img: Element): boolean {
  const style = (img.getAttribute("style") || "").toLowerCase();
  if (/display\s*:\s*none/.test(style)) return true;
  if (/visibility\s*:\s*hidden/.test(style)) return true;
  if (/opacity\s*:\s*0\b/.test(style)) return true;
  return false;
}

const ORIGINAL_STYLE = "data-prudii-style";
const ORIGINAL_CSS = "data-prudii-css";
const ORIGINAL_SRC = "data-prudii-src";
const ORIGINAL_BACKGROUND = "data-prudii-background";

// The frame renders light and dark mode inverts that, so a mail's own dark variant must never apply.
function lightSchemeOnly(css: string): string {
  return css
    .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, "(max-width: -1px)")
    .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, "(min-width: 0px)");
}

export function parseBody(html: string): HTMLElement {
  // DOMParser documents are inert: no image loads, no handlers. The explicit
  // <body> keeps leading <style> blocks out of <head>.
  return new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}`, "text/html").body;
}

// Sanitize email HTML: strip scripts, event handlers, dangerous elements
// but keep formatting, images (including data: URIs), links, tables, etc.
// When allowExternalImages is false, strips external image src attributes (keeps data: URIs).
// Detects and removes tracking pixels, returning info about them.
// `reversible` keeps what the display rewrites, so restoreSanitizedHtml can undo it.
export function sanitizeEmailHtml(html: string, allowExternalImages = true, reversible = false): SanitizeResult {
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "html", "head", "body", "div", "span", "p", "br", "hr",
      "b", "i", "u", "s", "em", "strong", "small", "sub", "sup", "mark",
      "del", "ins", "abbr", "cite", "code", "pre", "blockquote",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "ul", "ol", "li", "dl", "dt", "dd",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
      "img", "picture", "source", "figure", "figcaption",
      "a",
      "center", "section", "article", "header", "footer", "nav", "main", "aside",
      // Styling (<style> allowed — url() stripped post-sanitize for tracking protection)
      "style", "font",
      "wbr", "details", "summary",
    ],
    ALLOWED_ATTR: [
      "class", "id", "style", "dir", "lang", "title",
      "href", "target", "rel",
      "src", "alt", "width", "height", "loading",
      "colspan", "rowspan", "cellpadding", "cellspacing", "border", "align", "valign", "bgcolor", "background",
      "color", "face", "size",
      "srcset", "sizes", "media", "type",
    ],
    // Set by this function only; a mail carrying them could turn text into links or swap what an edit restores.
    FORBID_ATTR: ["data-href", ORIGINAL_STYLE, ORIGINAL_CSS, ORIGINAL_SRC, ORIGINAL_BACKGROUND],
    // file:/asset: carry locally stored inline images (rewritten to asset URLs before display)
    // cid:/blob: load nothing here; kept so the inline-image resolver can map or drop them
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data|file|asset|cid|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    FORCE_BODY: true,
    // Extra: strip JS event handlers (onclick, onerror, etc.) — DOMPurify does this by default
  });

  // Strip url() from inline styles AND <style> blocks to prevent CSS tracking pixels
  // (e.g. background-image: url('https://tracker.example.com/pixel.gif'))
  // Inert parse: a live element would start fetching the tracker pixels removed below.
  const div = parseBody(sanitized);
  div.querySelectorAll("[background]").forEach((el) => {
    if (reversible) el.setAttribute(ORIGINAL_BACKGROUND, el.getAttribute("background") ?? "");
    el.removeAttribute("background");
  });
  div.querySelectorAll("[style]").forEach((el) => {
    const style = el.getAttribute("style") || "";
    if (/url\s*\(/i.test(style)) {
      if (reversible) el.setAttribute(ORIGINAL_STYLE, style);
      el.setAttribute("style", style.replace(/url\s*\([^)]*\)/gi, "none"));
    }
  });
  div.querySelectorAll("style").forEach((styleEl) => {
    const css = styleEl.textContent || "";
    const shown = lightSchemeOnly(css.replace(/url\s*\([^)]*\)/gi, "none"));
    if (shown !== css) {
      if (reversible) styleEl.setAttribute(ORIGINAL_CSS, css);
      styleEl.textContent = shown;
    }
  });

  const trackers: TrackerInfo[] = [];
  const toRemove: Element[] = [];

  div.querySelectorAll("img[src]").forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (!src.startsWith("http://") && !src.startsWith("https://")) return;

    const domain = getDomain(src);
    let trackerType: TrackerInfo["type"] | null = null;

    if (isPixelImage(img)) {
      trackerType = "pixel";
    } else if (isHiddenImage(img)) {
      trackerType = "hidden";
    } else if (isTrackerDomain(domain)) {
      trackerType = "tracking_domain";
    }

    if (trackerType) {
      trackers.push({ domain, type: trackerType, src });
      toRemove.push(img);
    }
  });

  for (const el of toRemove) {
    el.remove();
  }

  // Keep data: URIs intact (inline/CID images)
  if (!allowExternalImages) {
    div.querySelectorAll("img[src]").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (src.startsWith("http://") || src.startsWith("https://")) {
        img.removeAttribute("src");
      }
    });
  }

  // Move href → data-href on all links so that no browser-native link behavior
  // interferes with our click handler (WebKit swallows clicks on <a href> in
  // sandboxed iframes before the JS click event fires).
  div.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (href) {
      a.setAttribute("data-href", href);
      a.removeAttribute("href");
      if (reversible) return;
      a.setAttribute("role", "link");
      a.setAttribute("tabindex", "0");
      (a as HTMLElement).style.cursor = "pointer";
    }
  });

  return { html: div.innerHTML, trackers };
}

/** Point locally stored inline images (file://) at a URL the webview can load. */
export function showLocalImages(html: string, toDisplay: (fileUrl: string) => string, reversible = false): string {
  if (!html.includes("file://")) return html;
  const body = parseBody(html);
  body.querySelectorAll('img[src^="file://"]').forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (reversible) img.setAttribute(ORIGINAL_SRC, src);
    img.setAttribute("src", toDisplay(src));
  });
  return body.innerHTML;
}

/** Undo the display rewrites of a reversible sanitize, for HTML that leaves the app again. */
export function restoreSanitizedHtml(html: string): string {
  const body = parseBody(html);
  body.querySelectorAll("a[data-href]").forEach((a) => {
    a.setAttribute("href", a.getAttribute("data-href") ?? "");
    a.removeAttribute("data-href");
  });
  body.querySelectorAll(`[${ORIGINAL_STYLE}]`).forEach((el) => {
    el.setAttribute("style", el.getAttribute(ORIGINAL_STYLE) ?? "");
    el.removeAttribute(ORIGINAL_STYLE);
  });
  body.querySelectorAll(`[${ORIGINAL_BACKGROUND}]`).forEach((el) => {
    el.setAttribute("background", el.getAttribute(ORIGINAL_BACKGROUND) ?? "");
    el.removeAttribute(ORIGINAL_BACKGROUND);
  });
  body.querySelectorAll(`style[${ORIGINAL_CSS}]`).forEach((el) => {
    el.textContent = el.getAttribute(ORIGINAL_CSS);
    el.removeAttribute(ORIGINAL_CSS);
  });
  body.querySelectorAll(`img[${ORIGINAL_SRC}]`).forEach((img) => {
    img.setAttribute("src", img.getAttribute(ORIGINAL_SRC) ?? "");
    img.removeAttribute(ORIGINAL_SRC);
  });
  return body.innerHTML;
}
