import { useState, useEffect, useCallback, useMemo } from "react";
import { Code, Type, Eye } from "lucide-react";
import { useTranslation } from "react-i18next";
import { escapeHtml, sanitizeSignatureHtml } from "../../lib/sanitize";
import {
  collapseDataUris,
  derivePlainText,
  expandDataUris,
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
  // put back before anything is stored.
  const collapsed = useMemo(() => collapseDataUris(html), [html]);
  const [source, setSource] = useState(collapsed.html);
  useEffect(() => {
    setSource(collapseDataUris(html).html);
  }, [html]);

  const commit = useCallback((newHtml: string) => {
    setHtml(newHtml);
    onChange(newHtml, derivePlainText(newHtml));
  }, [onChange]);

  // Sanitizing runs on blur, never per keystroke — otherwise half-typed tags get
  // rewritten under the caret and the caret jumps to the end.
  const commitSource = useCallback(() => {
    const expanded = expandDataUris(source, collapsed.images);
    const cleaned = cleanSignatureHtml(expanded);
    setNotice(elementCount(cleaned) < elementCount(expanded) ? t("signature.sanitized") : "");
    commit(cleaned);
  }, [source, collapsed.images, commit, t]);

  const commitPlainText = useCallback((newText: string) => {
    const newHtml = newText
      .split("\n")
      .map((line) => `<div>${escapeHtml(line) || "<br>"}</div>`)
      .join("");
    setHtml(newHtml);
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
              value={structured ? derivedText : htmlToPlainLines(html)}
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
