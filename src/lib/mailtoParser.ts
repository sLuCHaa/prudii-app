export interface MailtoParams {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export function parseMailtoUrl(url: string): MailtoParams {
  const result: MailtoParams = { to: [], cc: [], bcc: [], subject: "", body: "" };

  if (!url.startsWith("mailto:")) return result;

  // Split "mailto:addr1,addr2?key=val&key=val"
  const withoutScheme = url.slice(7);
  const qIndex = withoutScheme.indexOf("?");
  const addressPart = qIndex >= 0 ? withoutScheme.slice(0, qIndex) : withoutScheme;
  const queryPart = qIndex >= 0 ? withoutScheme.slice(qIndex + 1) : "";

  if (addressPart) {
    result.to = addressPart
      .split(",")
      .map((a) => decodeURIComponent(a).trim())
      .filter(Boolean);
  }

  if (queryPart) {
    for (const pair of queryPart.split("&")) {
      const eqIndex = pair.indexOf("=");
      if (eqIndex < 0) continue;
      const key = pair.slice(0, eqIndex).toLowerCase();
      const value = decodeURIComponent(pair.slice(eqIndex + 1));
      switch (key) {
        case "to":
          result.to.push(...value.split(",").map((a) => a.trim()).filter(Boolean));
          break;
        case "cc":
          result.cc.push(...value.split(",").map((a) => a.trim()).filter(Boolean));
          break;
        case "bcc":
          result.bcc.push(...value.split(",").map((a) => a.trim()).filter(Boolean));
          break;
        case "subject":
          result.subject = value;
          break;
        case "body":
          result.body = value;
          break;
      }
    }
  }

  return result;
}
