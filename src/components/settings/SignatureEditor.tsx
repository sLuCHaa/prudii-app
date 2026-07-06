import { useState, useEffect, useCallback } from "react";
import { Code, Type } from "lucide-react";
import { useTranslation } from "react-i18next";
import { sanitizeSignatureHtml } from "../../lib/sanitize";

interface SignatureEditorProps {
  htmlValue: string;
  textValue: string;
  onChange: (html: string, text: string) => void;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function SignatureEditor({ htmlValue, textValue, onChange }: SignatureEditorProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"text" | "html">("text");
  const [html, setHtml] = useState(htmlValue);
  const [text, setText] = useState(textValue);

  useEffect(() => {
    setHtml(htmlValue);
    setText(textValue);
  }, [htmlValue, textValue]);

  const notifyChange = useCallback((newHtml: string, newText: string) => {
    onChange(newHtml, newText);
  }, [onChange]);

  // Strip non-content elements (style/script/head/meta/link) that come along when
  // pasting a full HTML document (e.g. a copied page brings the browser's default
  // stylesheet), so the stored signature is just the real content. Runs the input
  // through DOMPurify first so pasted markup can never inject scripts/handlers.
  function cleanSignatureHtml(html: string): string {
    const safe = sanitizeSignatureHtml(html);
    if (!/<style|<head|<!doctype|<script|<meta|<link/i.test(safe)) return safe;
    const doc = new DOMParser().parseFromString(safe, "text/html");
    doc.querySelectorAll("style, script, link, meta, title, head").forEach((el) => el.remove());
    return (doc.body?.innerHTML ?? safe).trim();
  }

  // Extract plain text from HTML — drop styles/scripts and trim leading/trailing
  // blank lines so the plain-text version isn't polluted with CSS or empty lines.
  function htmlToPlainText(htmlContent: string): string {
    const doc = new DOMParser().parseFromString(sanitizeSignatureHtml(htmlContent), "text/html");
    doc.querySelectorAll("style, script, head").forEach((el) => el.remove());
    return (doc.body?.textContent ?? "").replace(/^\s+/, "").trimEnd();
  }

  function handleHtmlChange(rawHtml: string) {
    const newHtml = cleanSignatureHtml(rawHtml);
    const newText = htmlToPlainText(newHtml);
    setHtml(newHtml);
    setText(newText);
    notifyChange(newHtml, newText);
  }

  function handleTextChange(newText: string) {
    setText(newText);
    const newHtml = newText
      .split("\n")
      .map((line) => `<div>${escapeHtml(line) || "<br>"}</div>`)
      .join("");
    setHtml(newHtml);
    notifyChange(newHtml, newText);
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center px-3 py-2 border-b border-border bg-bg-secondary">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMode("text")}
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${
              mode === "text"
                ? "bg-accent-soft text-accent"
                : "text-text-tertiary hover:text-text-secondary hover:bg-hover"
            }`}
          >
            <Type className="w-3.5 h-3.5" />
            {t("signature.plainText")}
          </button>
          <button
            onClick={() => setMode("html")}
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${
              mode === "html"
                ? "bg-accent-soft text-accent"
                : "text-text-tertiary hover:text-text-secondary hover:bg-hover"
            }`}
          >
            <Code className="w-3.5 h-3.5" />
            HTML
          </button>
        </div>
      </div>

      <div className="min-h-[240px]">
        {mode === "text" && (
          <textarea
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            className="w-full p-3 min-h-[240px] text-sm text-text bg-transparent resize-y"
            placeholder={t("signature.textPlaceholder", "Best regards\nJohn Doe")}
          />
        )}

        {mode === "html" && (
          <textarea
            value={html}
            onChange={(e) => handleHtmlChange(e.target.value)}
            className="w-full p-3 min-h-[240px] text-sm text-text bg-transparent font-mono resize-none"
            placeholder="<div>Your signature HTML here...</div>"
          />
        )}
      </div>
    </div>
  );
}
