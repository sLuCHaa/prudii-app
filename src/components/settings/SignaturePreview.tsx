import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { plainTextParagraph, sanitizeSignatureHtml } from "../../lib/sanitize";

// Links must not navigate the frame away from the preview.
const PAGE_STYLES = `
  html, body { margin: 0; padding: 12px; background: #fff; color: #000;
    font-family: -apple-system, system-ui, sans-serif; font-size: 13px; }
  a { pointer-events: none; }
`;

/** A signature as it goes out, on the white page a recipient sees; nothing in it runs or can be edited. */
export function SignaturePreview({ html, text }: { html: string; text: string }) {
  const { t } = useTranslation();
  const srcDoc = useMemo(() => {
    const body = html.trim() ? sanitizeSignatureHtml(html) : plainTextParagraph(text);
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none';"><style>${PAGE_STYLES}</style></head><body>${body}</body></html>`;
  }, [html, text]);

  return (
    <iframe
      srcDoc={srcDoc}
      sandbox=""
      className="w-full h-[180px] rounded-lg border border-border bg-white"
      title={t("signature.previewTitle")}
    />
  );
}
