import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { buildPreviewHtml, parseSignature, setSignatureText } from "../../lib/signatureHtml";
import { SIGNATURE_EDIT_BRIDGE, SIGNATURE_EDIT_BRIDGE_CSP_HASH } from "../../lib/signatureEditBridge";

interface Props {
  html: string;
  onChange: (html: string) => void;
}

const BASE_STYLES = `
  html, body { margin: 0; padding: 12px; background: #fff; color: #000;
    font-family: -apple-system, system-ui, sans-serif; font-size: 13px; }
  [data-sig-text]:hover { outline: 1px dashed rgba(0,0,0,.28); }
  [data-sig-text]:focus { outline: 2px solid #3b82f6; outline-offset: 1px; }
`;

export function SignaturePreviewEditor({ html, onChange }: Props) {
  const { t } = useTranslation();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);

  // The model is rebuilt only when the signature changes from the outside.
  // Typing must not rebuild it, or the iframe would re-render and the caret
  // would jump to the start on every keystroke.
  const model = useMemo(() => parseSignature(html), [html]);
  const modelRef = useRef(model);
  useEffect(() => { modelRef.current = model; }, [model]);

  const srcDoc = useMemo(
    () => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src '${SIGNATURE_EDIT_BRIDGE_CSP_HASH}'; object-src 'none';"><style>${BASE_STYLES}</style></head><body>${buildPreviewHtml(html)}<script>${SIGNATURE_EDIT_BRIDGE}</script></body></html>`,
    // Deliberately keyed on the incoming html only — see the note above.
    [html]
  );

  const resize = useCallback(() => {
    try {
      const h = iframeRef.current?.contentDocument?.body?.scrollHeight;
      if (h && h > 0) setHeight(h + 8);
    } catch {}
  }, []);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const edit = (e.data as { __prudiiSigEdit?: { index: number; text: string } })?.__prudiiSigEdit;
      if (!edit) return;
      onChange(setSignatureText(modelRef.current, edit.index, edit.text));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onChange]);

  if (!html.trim()) {
    return (
      <div className="p-6 text-sm text-text-tertiary text-center">
        {t("signature.emptyPreview")}
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-scripts"
      onLoad={resize}
      style={{ height }}
      className="w-full border-0 bg-white"
      title={t("signature.previewTitle")}
    />
  );
}
