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

// Sanitize email HTML: strip scripts, event handlers, dangerous elements
// but keep formatting, images (including data: URIs), links, tables, etc.
// When allowExternalImages is false, strips external image src attributes (keeps data: URIs).
// Detects and removes tracking pixels, returning info about them.
export function sanitizeEmailHtml(html: string, allowExternalImages = true): SanitizeResult {
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
      "colspan", "rowspan", "cellpadding", "cellspacing", "border", "align", "valign", "bgcolor",
      "color", "face", "size",
      "srcset", "sizes", "media", "type",
    ],
    // Allow data: URIs for inline images (cid: already converted to data: by backend)
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    FORCE_BODY: true,
    // Extra: strip JS event handlers (onclick, onerror, etc.) — DOMPurify does this by default
  });

  // Strip url() from inline styles AND <style> blocks to prevent CSS tracking pixels
  // (e.g. background-image: url('https://tracker.example.com/pixel.gif'))
  const div = document.createElement("div");
  div.innerHTML = sanitized;
  div.querySelectorAll("[style]").forEach((el) => {
    const style = el.getAttribute("style") || "";
    if (/url\s*\(/i.test(style)) {
      el.setAttribute("style", style.replace(/url\s*\([^)]*\)/gi, "none"));
    }
  });
  div.querySelectorAll("style").forEach((styleEl) => {
    const css = styleEl.textContent || "";
    if (/url\s*\(/i.test(css)) {
      styleEl.textContent = css.replace(/url\s*\([^)]*\)/gi, "none");
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
      a.setAttribute("role", "link");
      a.setAttribute("tabindex", "0");
      (a as HTMLElement).style.cursor = "pointer";
    }
  });

  return { html: div.innerHTML, trackers };
}
