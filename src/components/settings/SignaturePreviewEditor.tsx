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

  // `renderedHtml` is what the iframe is actually built from. `html` changes
  // on every keystroke too (our own edits flow out via onChange and straight
  // back in as the next `html` prop), but `srcDoc` is a hard iframe reload —
  // rebuilding it mid-edit would tear down focus and snap the caret back to
  // the start. So `renderedHtml` must only follow `html` when the change is
  // genuinely external (account switch, Source tab applied, initial load),
  // never when it's an echo of an edit this component itself just emitted.
  // `lastEmittedRef` remembers the last value we sent through `onChange` so
  // that echo can be recognised and ignored. Do not "simplify" this by
  // keying srcDoc on `html` directly — that reintroduces the reload-per-
  // keystroke bug found in review.
  const [renderedHtml, setRenderedHtml] = useState(html);
  const lastEmittedRef = useRef<string | null>(null);

  useEffect(() => {
    if (html === lastEmittedRef.current) return; // our own echo — ignore
    setRenderedHtml(html);
  }, [html]);

  const model = useMemo(() => parseSignature(renderedHtml), [renderedHtml]);
  const modelRef = useRef(model);
  useEffect(() => { modelRef.current = model; }, [model]);

  const srcDoc = useMemo(
    () => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src '${SIGNATURE_EDIT_BRIDGE_CSP_HASH}'; object-src 'none';"><style>${BASE_STYLES}</style></head><body>${buildPreviewHtml(renderedHtml)}<script>${SIGNATURE_EDIT_BRIDGE}</script></body></html>`,
    // Deliberately keyed on renderedHtml, not the raw html prop — see the note above.
    [renderedHtml]
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
      const next = setSignatureText(modelRef.current, edit.index, edit.text);
      // Record before emitting so the effect above recognises the round trip
      // as our own echo, not an external change, when `html` updates to `next`.
      lastEmittedRef.current = next;
      onChange(next);
      // The frame doesn't reload on this edit (by design, see above), so
      // `onLoad` won't fire to re-measure height. Reading contentDocument
      // from the parent works fine here — it's cross-frame *events* that
      // don't reach the parent on macOS/WKWebView, not synchronous reads.
      resize();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onChange, resize]);

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
