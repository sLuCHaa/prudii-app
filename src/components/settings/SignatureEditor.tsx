import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Code, Type, Eye } from "lucide-react";
import { useTranslation } from "react-i18next";
import { escapeHtml, sanitizeSignatureHtml } from "../../lib/sanitize";
import {
  collapseDataUris,
  derivePlainText,
  expandDataUris,
  hasBrokenDataUri,
  hasStructure,
  htmlToPlainLines,
} from "../../lib/signatureHtml";
import { SignaturePreviewEditor } from "./SignaturePreviewEditor";

interface SignatureEditorProps {
  htmlValue: string;
  textValue: string;
  onChange: (html: string, text: string) => void;
}

// NOTE: the file's old local `escapeHtml` is deliberately gone — `sanitize.ts`
// already exports a character-for-character identical one. Do not reintroduce it.

// Strip non-content elements (style/script/head/meta/link) that come along when
// pasting a full HTML document, so the stored signature is just the real content.
function cleanSignatureHtml(html: string): string {
  const safe = sanitizeSignatureHtml(html);
  if (!/<style|<head|<!doctype|<script|<meta|<link/i.test(safe)) return safe;
  const doc = new DOMParser().parseFromString(safe, "text/html");
  doc.querySelectorAll("style, script, link, meta, title, head").forEach((el) => el.remove());
  return (doc.body?.innerHTML ?? safe).trim();
}

function elementCount(html: string): number {
  return new DOMParser().parseFromString(html, "text/html").body.querySelectorAll("*").length;
}

type Mode = "preview" | "text" | "html";

export function SignatureEditor({ htmlValue, textValue, onChange }: SignatureEditorProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("preview");
  const [html, setHtml] = useState(htmlValue);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setHtml(htmlValue);
  }, [htmlValue]);

  const structured = useMemo(() => hasStructure(html), [html]);
  const derivedText = useMemo(() => derivePlainText(html), [html]);

  // The source view shows shortened data URIs; the originals live here and are
  // put back before anything is stored. The placeholder's readable half is
  // translated — it is the only thing telling the user those few characters stand
  // for the logo, so it must not stay German in a seven-locale app.
  const imageLabel = useCallback(
    (kb: number) => t("signature.imagePlaceholder", { kb }),
    [t]
  );
  const collapsed = useMemo(() => collapseDataUris(html, imageLabel), [html, imageLabel]);
  const [source, setSource] = useState(collapsed.html);
  useEffect(() => {
    setSource(collapsed.html);
  }, [collapsed.html]);

  // The plain-text tab's draft is held verbatim while the user types, never derived
  // from `html` on every keystroke — that round trip through htmlToPlainLines is
  // exactly what caused the newline/entity/leading-blank bugs found in review.
  // Mirrors SignaturePreviewEditor's echo-suppression (`lastEmittedRef`): the effect
  // only re-derives the draft from `html` when the change is genuinely external
  // (mount, account switch, an edit committed from the Preview or HTML tab) —
  // never when it's the echo of commitPlainText's own edit.
  const [plainDraft, setPlainDraft] = useState(() => htmlToPlainLines(htmlValue));
  const lastPlainEmittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (html === lastPlainEmittedRef.current) return; // our own echo — ignore
    setPlainDraft(htmlToPlainLines(html));
  }, [html]);

  const commit = useCallback((newHtml: string) => {
    setHtml(newHtml);
    onChange(newHtml, derivePlainText(newHtml));
  }, [onChange]);

  // Sanitizing runs on blur, never per keystroke — otherwise half-typed tags get
  // rewritten under the caret and the caret jumps to the end.
  const commitSource = useCallback(() => {
    // Blurring without having typed anything must not rewrite the signature.
    // sanitize + DOMParser + innerHTML normalises attribute quoting, tag case,
    // entities and self-closing tags, so for a real Outlook- or Apple-Mail-built
    // table signature the round trip almost always differs textually — enough to
    // flip the settings form to dirty and, on save, silently replace what the
    // user had with the re-serialised version. `collapsed.html` is exactly what
    // was rendered into the box, so comparing against it detects "no edit".
    if (source === collapsed.html) return;

    const expanded = expandDataUris(source, collapsed.images);
    // A placeholder that was mangled rather than deleted expands into a `data:`
    // URI with a non-base64 payload. Committing that would drop the real image
    // bytes out of state for good, with nothing warning the user, so refuse and
    // leave the textarea as typed so the edit can be undone.
    if (hasBrokenDataUri(expanded)) {
      setNotice(t("signature.imagePlaceholderBroken"));
      return;
    }
    const cleaned = cleanSignatureHtml(expanded);
    setNotice(elementCount(cleaned) < elementCount(expanded) ? t("signature.sanitized") : "");
    commit(cleaned);
  }, [source, collapsed, commit, t]);

  const commitPlainText = useCallback((newText: string) => {
    const newHtml = newText
      .split("\n")
      .map((line) => `<div>${escapeHtml(line) || "<br>"}</div>`)
      .join("");
    lastPlainEmittedRef.current = newHtml;
    setHtml(newHtml);
    setPlainDraft(newText);
    onChange(newHtml, newText);
  }, [onChange]);

  const tabs: Array<[Mode, string, typeof Eye]> = [
    ["preview", t("signature.preview"), Eye],
    ["text", t("signature.plainText"), Type],
    ["html", "HTML", Code],
  ];

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center px-3 py-2 border-b border-border bg-bg-secondary">
        <div className="flex items-center gap-1">
          {tabs.map(([value, label, Icon]) => (
            <button
              key={value}
              onClick={() => setMode(value)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${
                mode === value
                  ? "bg-accent-soft text-accent"
                  : "text-text-tertiary hover:text-text-secondary hover:bg-hover"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-[240px]">
        {mode === "preview" && (
          <SignaturePreviewEditor html={html} onChange={commit} />
        )}

        {mode === "text" && (
          <>
            {structured && (
              <p className="px-3 pt-2 text-xs text-text-tertiary">
                {t("signature.derivedFromHtml")}
              </p>
            )}
            <textarea
              value={structured ? derivedText : plainDraft}
              readOnly={structured}
              onChange={(e) => commitPlainText(e.target.value)}
              className="w-full p-3 min-h-[240px] text-sm text-text bg-transparent resize-y disabled:opacity-60"
              placeholder={t("signature.textPlaceholder", "Best regards\nJohn Doe")}
            />
          </>
        )}

        {mode === "html" && (
          <>
            {collapsed.images.length > 0 && (
              <p className="px-3 pt-2 text-xs text-text-tertiary">
                {t("signature.imagesCollapsed")}
              </p>
            )}
            <textarea
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onBlur={commitSource}
              className="w-full p-3 min-h-[240px] text-sm text-text bg-transparent font-mono resize-y"
              placeholder="<div>Your signature HTML here...</div>"
            />
          </>
        )}
      </div>

      {notice && (
        <p className="px-3 py-2 text-xs text-warning border-t border-border">{notice}</p>
      )}
    </div>
  );
}
