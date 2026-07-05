import { useState, useEffect } from "react";
import { MessageSquareReply, Loader2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { suggestReplies, suggestThreadReplies } from "../../lib/tauri";
import type { AiRepliesEvent, ReplySuggestion } from "../../types";

interface AiReplySuggestionsProps {
  mailId: string;
  threadMode?: boolean;
}

const TONE_KEYS: Record<string, string> = {
  professional: "ai.professional",
  friendly: "ai.friendly",
  concise: "ai.concise",
};

const TONE_COLORS: Record<string, string> = {
  professional: "border-blue-500/30 bg-blue-500/5",
  friendly: "border-green-500/30 bg-green-500/5",
  concise: "border-orange-500/30 bg-orange-500/5",
};

export function AiReplyButton({ mailId, onToggle, active }: AiReplySuggestionsProps & { onToggle: () => void; active: boolean }) {
  const { t } = useTranslation();
  const appSettings = useAppStore((s) => s.appSettings);

  if (!appSettings.ai_enabled) return null;

  return (
    <button
      title={t("ai.suggestReply")}
      onClick={onToggle}
      className={`p-2 rounded-lg hover:bg-hover transition-colors ${
        active ? "text-accent bg-accent/10" : "text-text-tertiary"
      }`}
    >
      <MessageSquareReply className="w-4 h-4" />
    </button>
  );
}

export function AiReplySuggestionsPanel({ mailId, threadMode }: AiReplySuggestionsProps) {
  const { t } = useTranslation();
  const openCompose = useAppStore((s) => s.openCompose);
  const mails = useAppStore((s) => s.mails);
  const [replies, setReplies] = useState<ReplySuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);

  async function startSuggestions() {
    setReplies([]);
    setError(null);
    setLoading(true);

    try {
      const result = threadMode ? await suggestThreadReplies(mailId) : await suggestReplies(mailId);

      // Cache hit — use directly, no need for events
      if (result.cached_text) {
        try {
          const parsed = JSON.parse(result.cached_text) as ReplySuggestion[];
          setReplies(parsed);
        } catch {
          setError("Failed to parse cached replies");
        }
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

    const unlisten = listen<AiRepliesEvent>("ai-replies", (event) => {
      const data = event.payload;
      if (data.request_id !== requestId) return;

      if (data.error) {
        setError(data.error);
      }

      if (data.replies && data.replies.length > 0) {
        setReplies(data.replies);
      }

      setLoading(false);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [requestId]);

  useEffect(() => {
    startSuggestions();
  }, [mailId]);

  function handleUseReply(text: string) {
    const mail = mails.find((m) => m.id === mailId);
    if (mail) {
      openCompose("reply", mail, text);
    }
  }

  return (
    <div className="mx-6 mt-3 mb-1 p-3 rounded-lg bg-accent/5 border border-accent/20">
      <div className="flex items-center gap-2 mb-3">
        <MessageSquareReply className="w-3.5 h-3.5 text-accent" />
        <span className="text-xs font-semibold text-accent">{t("ai.suggestReply")}</span>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-4">
          <Loader2 className="w-4 h-4 text-accent animate-spin" />
          <span className="text-xs text-text-tertiary">{t("ai.generatingReplies")}</span>
        </div>
      )}

      {error && (
        <p className="text-xs text-danger mb-2">
          {error === "OLLAMA_NOT_RUNNING" ? t("settings.ai.ollamaNotRunning") : error}
        </p>
      )}

      {replies.length > 0 && (
        <div className="space-y-2">
          {replies.map((reply, i) => (
            <div
              key={i}
              className={`p-3 rounded-lg border transition-colors ${
                TONE_COLORS[reply.tone] || "border-border bg-surface"
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-text-secondary">
                  {t(TONE_KEYS[reply.tone] || reply.tone)}
                </span>
                <button
                  onClick={() => handleUseReply(reply.text)}
                  className="text-[11px] font-medium text-accent hover:text-accent-hover transition-colors"
                >
                  {t("ai.useReply")}
                </button>
              </div>
              <p className="text-xs text-text-secondary leading-relaxed line-clamp-4">
                {reply.text}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
