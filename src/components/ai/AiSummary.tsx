import { useState, useEffect, useRef } from "react";
import { Sparkles, RefreshCw, X, Loader2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { summarizeMail, summarizeThread, clearAiCache } from "../../lib/tauri";
import type { AiStreamEvent } from "../../types";

interface AiSummaryProps {
  mailId: string;
  threadMode?: boolean;
}

export function AiSummaryButton({ mailId, threadMode, onToggle, active }: AiSummaryProps & { onToggle: () => void; active: boolean }) {
  const { t } = useTranslation();
  const appSettings = useAppStore((s) => s.appSettings);

  if (!appSettings.ai_enabled) return null;

  return (
    <button
      title={threadMode ? t("ai.summarizeThread") : t("ai.summarize")}
      onClick={onToggle}
      className={`p-2 rounded-lg hover:bg-hover transition-colors ${
        active ? "text-accent bg-accent/10" : "text-text-tertiary"
      }`}
    >
      <Sparkles className="w-4 h-4" />
    </button>
  );
}

export function AiSummaryPanel({ mailId, threadMode }: AiSummaryProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const textRef = useRef("");

  async function startSummary() {
    setText("");
    textRef.current = "";
    setError(null);
    setLoading(true);

    try {
      const result = threadMode
        ? await summarizeThread(mailId)
        : await summarizeMail(mailId);

      // Cache hit — use directly, no need for events
      if (result.cached_text) {
        textRef.current = result.cached_text;
        setText(result.cached_text);
        setLoading(false);
      } else {
        setRequestId(result.request_id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!requestId) return;

    const unlisten = listen<AiStreamEvent>("ai-stream", (event) => {
      const data = event.payload;
      if (data.request_id !== requestId) return;

      if (data.error) {
        setError(data.error);
        setLoading(false);
        return;
      }

      if (data.chunk) {
        textRef.current += data.chunk;
        setText(textRef.current);
      }

      if (data.done) {
        setLoading(false);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [requestId]);

  useEffect(() => {
    startSummary();
  }, [mailId]);

  async function handleRegenerate() {
    await clearAiCache(mailId);
    startSummary();
  }

  return (
    <div className="mx-6 mt-3 mb-1 p-3 rounded-lg bg-accent/5 border border-accent/20">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-3.5 h-3.5 text-accent" />
        <span className="text-xs font-semibold text-accent">
          {threadMode ? t("ai.threadSummary") : t("ai.summary")}
        </span>
        <div className="flex-1" />
        {!loading && text && (
          <button
            onClick={handleRegenerate}
            className="p-1 rounded hover:bg-hover transition-colors text-text-tertiary"
            title={t("ai.regenerate")}
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        )}
      </div>

      {loading && !text && (
        <div className="flex items-center gap-2 py-2">
          <Loader2 className="w-4 h-4 text-accent animate-spin" />
          <span className="text-xs text-text-tertiary">{t("ai.summarizing")}</span>
        </div>
      )}

      {error && (
        <p className="text-xs text-danger">
          {error === "OLLAMA_NOT_RUNNING" ? t("settings.ai.ollamaNotRunning") : error}
        </p>
      )}

      {text && (
        <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
          {text}
          {loading && <span className="inline-block w-1.5 h-4 bg-accent/60 ml-0.5 animate-pulse align-middle" />}
        </p>
      )}
    </div>
  );
}
