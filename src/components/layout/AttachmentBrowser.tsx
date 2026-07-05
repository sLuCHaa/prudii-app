import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Search, Download, Check, ArrowUpDown, ArrowUp, ArrowDown, FileText, Image, FileSpreadsheet, File, Loader2, Paperclip, Mail, ChevronDown, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { searchAttachments, countAttachments, bulkSaveAttachments, saveAttachment, aiSearchAttachments } from "../../lib/tauri";
import { listen } from "@tauri-apps/api/event";
import { formatMailDate } from "../../lib/dateUtils";
import { EmptyState } from "../ui/EmptyState";
import { useScroller } from "../../hooks/useScroller";
import { AttachmentPreview } from "./AttachmentPreview";
import { ResizeHandle } from "./ResizeHandle";
import { ImageLightbox, type ImageLightboxItem } from "./ImageLightbox";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { AttachmentWithContext, AiSearchResultEvent } from "../../types";

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(mimeType: string | null, filename: string) {
  const mime = mimeType?.toLowerCase() || "";
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) {
    return <Image className="w-4 h-4 text-emerald-500" />;
  }
  if (mime === "application/pdf" || ext === "pdf") {
    return <FileText className="w-4 h-4 text-red-500" />;
  }
  if (mime.includes("spreadsheet") || mime.includes("excel") || ["xlsx", "xls", "csv"].includes(ext)) {
    return <FileSpreadsheet className="w-4 h-4 text-green-600" />;
  }
  if (mime.includes("word") || mime.includes("document") || ["docx", "doc"].includes(ext)) {
    return <FileText className="w-4 h-4 text-blue-600" />;
  }
  return <File className="w-4 h-4 text-text-tertiary" />;
}

type SortBy = "date" | "filename" | "size";
type SortOrder = "asc" | "desc";

const FILE_TYPE_EXTENSIONS: Record<string, string[]> = {
  pdf: ["pdf"],
  images: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"],
  documents: ["doc", "docx", "odt", "rtf", "txt"],
  spreadsheets: ["xls", "xlsx", "csv", "ods"],
  archives: ["zip", "rar", "7z", "tar", "gz"],
};

const ALL_KNOWN_EXTENSIONS = Object.values(FILE_TYPE_EXTENSIONS).flat();

function SortIcon({ column, activeSort, activeOrder }: { column: SortBy; activeSort: SortBy; activeOrder: SortOrder }) {
  if (column !== activeSort) return <ArrowUpDown className="w-3 h-3 opacity-0 group-hover/th:opacity-50" />;
  return activeOrder === "asc"
    ? <ArrowUp className="w-3 h-3 text-accent" />
    : <ArrowDown className="w-3 h-3 text-accent" />;
}

type FileTypeKey = "all" | "pdf" | "images" | "documents" | "spreadsheets" | "archives" | "other";

export function AttachmentBrowser() {
  const { t } = useTranslation();
  const appSettings = useAppStore((s) => s.appSettings);
  const accounts = useAppStore((s) => s.accounts);
  const setSelectedFolderId = useAppStore((s) => s.setSelectedFolderId);
  const setSelectedMailId = useAppStore((s) => s.setSelectedMailId);
  const addToast = useAppStore((s) => s.addToast);

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("date");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());
  const [selectedFileTypes, setSelectedFileTypes] = useState<Set<FileTypeKey>>(new Set(["all"]));
  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [attachments, setAttachments] = useState<AttachmentWithContext[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentWithContext | null>(null);
  const [previewWidth, setPreviewWidth] = useState(400);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const [aiSearchMode, setAiSearchMode] = useState(false);
  const [aiQuery, setAiQuery] = useState("");
  const [aiSearching, setAiSearching] = useState(false);
  const [aiResults, setAiResults] = useState<AttachmentWithContext[] | null>(null);
  const [aiParsedQuery, setAiParsedQuery] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);
  const aiInputRef = useRef<HTMLInputElement>(null);

  const handlePreviewResize = useCallback((delta: number) => {
    setPreviewWidth((w) => Math.max(300, Math.min(800, w - delta)));
  }, []);

  const listRef = useRef<HTMLDivElement>(null);
  // Themed overlay scrollbar on the list (keeps listRef as the scroll
  // viewport, so the infinite-scroll onScroll handler keeps working).
  useScroller(listRef);
  const PAGE_SIZE = 50;

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setAccountDropdownOpen(false);
      }
    }
    if (accountDropdownOpen) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [accountDropdownOpen]);

  const extensionFilter = useMemo(() => {
    if (selectedFileTypes.has("all") || selectedFileTypes.size === 0) {
      return { fileExtensions: undefined, excludeExtensions: undefined };
    }
    const types = Array.from(selectedFileTypes);
    const hasOther = types.includes("other");
    const normalTypes = types.filter((t) => t !== "other" && t !== "all") as (keyof typeof FILE_TYPE_EXTENSIONS)[];

    if (hasOther && normalTypes.length === 0) {
      // Only "Other" selected: exclude all known extensions
      return { fileExtensions: undefined, excludeExtensions: ALL_KNOWN_EXTENSIONS };
    }

    const includeExts = normalTypes.flatMap((t) => FILE_TYPE_EXTENSIONS[t] || []);

    if (hasOther) {
      // "Other" + some categories: no include filter, exclude the unselected known categories
      const selectedKnownExts = new Set(includeExts);
      const unselectedExts = ALL_KNOWN_EXTENSIONS.filter((e) => !selectedKnownExts.has(e));
      return { fileExtensions: undefined, excludeExtensions: unselectedExts.length > 0 ? unselectedExts : undefined };
    }

    // Only specific categories (no "Other")
    return { fileExtensions: includeExts, excludeExtensions: undefined };
  }, [selectedFileTypes]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const fetchAttachments = useCallback(async (reset: boolean) => {
    if (reset) {
      setLoading(true);
      setHasMore(true);
    } else {
      setLoadingMore(true);
    }

    try {
      const offset = reset ? 0 : attachments.length;
      const accountIds = selectedAccountIds.size > 0 ? Array.from(selectedAccountIds) : undefined;
      const filterParams = {
        query: debouncedQuery,
        accountIds,
        fileExtensions: extensionFilter.fileExtensions,
        excludeExtensions: extensionFilter.excludeExtensions,
      };

      const fetchPromise = searchAttachments({
        ...filterParams,
        sortBy,
        sortOrder,
        limit: PAGE_SIZE,
        offset,
      });

      const countPromise = reset ? countAttachments(filterParams) : null;

      const [results, count] = await Promise.all([fetchPromise, countPromise]);

      if (reset) {
        setAttachments(results);
        if (count != null) setTotalCount(count);
      } else {
        setAttachments((prev) => [...prev, ...results]);
      }
      setHasMore(results.length === PAGE_SIZE);
    } catch (err) {
      console.error("Failed to search attachments:", err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [debouncedQuery, sortBy, sortOrder, attachments.length, selectedAccountIds, extensionFilter]);

  useEffect(() => {
    fetchAttachments(true);
  }, [debouncedQuery, sortBy, sortOrder, selectedAccountIds, extensionFilter]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore || loadingMore) return;
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 300) {
      fetchAttachments(false);
    }
  }, [hasMore, loadingMore, fetchAttachments]);

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const displayedAttachments = aiResults ?? attachments;

  const imageLightboxItems = useMemo<ImageLightboxItem[]>(
    () =>
      displayedAttachments
        .filter((a) => a.mime_type?.startsWith("image/") && a.local_path)
        .map((a) => ({
          id: a.id,
          filename: a.filename,
          src: convertFileSrc(a.local_path!),
          sizeBytes: a.size_bytes,
          canDownload: true,
        })),
    [displayedAttachments],
  );

  const openLightboxFor = useCallback((att: AttachmentWithContext) => {
    const idx = imageLightboxItems.findIndex((i) => i.id === att.id);
    if (idx >= 0) setLightboxIndex(idx);
  }, [imageLightboxItems]);

  const handleLightboxDownload = useCallback(async (id: string) => {
    try {
      await saveAttachment(id);
    } catch (err) {
      addToast("error", t("attachments.downloadFailed"), err instanceof Error ? err.message : String(err));
    }
  }, [addToast, t]);

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === displayedAttachments.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(displayedAttachments.map((a) => a.id)));
    }
  }, [selectedIds.size, displayedAttachments]);

  const handleSort = useCallback((col: SortBy) => {
    if (sortBy === col) {
      setSortOrder((o) => o === "desc" ? "asc" : "desc");
    } else {
      setSortBy(col);
      setSortOrder("desc");
    }
  }, [sortBy]);

  const toggleAccountFilter = useCallback((accountId: string) => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }, []);

  const toggleFileType = useCallback((type: FileTypeKey) => {
    setSelectedFileTypes((prev) => {
      if (type === "all") return new Set(["all"]);
      const next = new Set(prev);
      next.delete("all");
      if (next.has(type)) {
        next.delete(type);
        if (next.size === 0) return new Set(["all"]);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const handleBulkDownload = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setDownloading(true);
    try {
      const result = await bulkSaveAttachments(Array.from(selectedIds));
      addToast(
        result.failed > 0 ? "warning" : "success",
        t("attachments.downloadComplete"),
        `${result.saved} ${t("attachments.saved")}${result.failed > 0 ? `, ${result.failed} ${t("attachments.failed")}` : ""}`,
      );
      setSelectedIds(new Set());
    } catch (err) {
      if (err !== "Cancelled" && String(err) !== "Cancelled") {
        addToast("error", t("attachments.downloadFailed"), String(err));
      }
    } finally {
      setDownloading(false);
    }
  }, [selectedIds, addToast, t]);

  const openMail = useCallback((att: AttachmentWithContext) => {
    // setSelectedFolderId already sets showAttachmentBrowser: false
    setSelectedFolderId(att.mail_folder_id);
    // Small delay so the mail list loads first
    setTimeout(() => setSelectedMailId(att.mail_id), 100);
  }, [setSelectedFolderId, setSelectedMailId]);

  const previewIndex = previewAttachment ? displayedAttachments.findIndex((a) => a.id === previewAttachment.id) : -1;
  const hasPrev = previewIndex > 0;
  const hasNext = previewIndex >= 0 && previewIndex < displayedAttachments.length - 1;

  const selectPrev = useCallback(() => {
    if (previewIndex > 0) setPreviewAttachment(displayedAttachments[previewIndex - 1]);
  }, [previewIndex, displayedAttachments]);

  const selectNext = useCallback(() => {
    if (previewIndex >= 0 && previewIndex < displayedAttachments.length - 1) setPreviewAttachment(displayedAttachments[previewIndex + 1]);
  }, [previewIndex, displayedAttachments]);

  const handleSingleDownload = useCallback(async (att: AttachmentWithContext) => {
    try {
      await saveAttachment(att.id);
    } catch (err) {
      if (err !== "Cancelled" && String(err) !== "Cancelled") {
        addToast("error", t("attachments.downloadFailed"), String(err));
      }
    }
  }, [addToast, t]);

  useEffect(() => {
    if (!previewAttachment) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setPreviewAttachment(null);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selectPrev();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        selectNext();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [previewAttachment, selectPrev, selectNext]);

  useEffect(() => {
    if (previewAttachment && !displayedAttachments.find((a) => a.id === previewAttachment.id)) {
      setPreviewAttachment(null);
    }
  }, [displayedAttachments, previewAttachment]);

  useEffect(() => {
    const unlisten = listen<AiSearchResultEvent>("ai-search-result", (event) => {
      setAiSearching(false);
      if (event.payload.error) {
        setAiError(event.payload.error);
        setAiResults(null);
      } else {
        setAiResults(event.payload.attachments);
        setAiParsedQuery(event.payload.parsed_query);
        setAiError(null);
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const handleAiSearch = useCallback(async () => {
    if (!aiQuery.trim()) return;
    setAiSearching(true);
    setAiError(null);
    setAiResults(null);
    setAiParsedQuery("");
    try {
      const accountIds = selectedAccountIds.size > 0 ? Array.from(selectedAccountIds) : undefined;
      await aiSearchAttachments(aiQuery.trim(), accountIds?.[0]);
    } catch (err) {
      setAiSearching(false);
      setAiError(String(err));
    }
  }, [aiQuery, selectedAccountIds]);

  const clearAiResults = useCallback(() => {
    setAiResults(null);
    setAiParsedQuery("");
    setAiError(null);
    setAiQuery("");
    setAiSearchMode(false);
  }, []);

  const accountLabel = selectedAccountIds.size === 0
    ? t("attachments.allAccounts")
    : selectedAccountIds.size === 1
      ? (accounts.find((a) => a.id === Array.from(selectedAccountIds)[0])?.display_name || t("attachments.allAccounts"))
      : `${selectedAccountIds.size} ${t("sidebar.accounts").toLowerCase()}`;

  const fileTypeChips: { key: FileTypeKey; label: string }[] = [
    { key: "all", label: t("attachments.typeAll") },
    { key: "pdf", label: t("attachments.typePdf") },
    { key: "images", label: t("attachments.typeImages") },
    { key: "documents", label: t("attachments.typeDocuments") },
    { key: "spreadsheets", label: t("attachments.typeSpreadsheets") },
    { key: "archives", label: t("attachments.typeArchives") },
    { key: "other", label: t("attachments.typeOther") },
  ];

  return (
    <div className="flex flex-col h-full bg-surface">
      <div className="px-6 py-3 border-b border-border no-select flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <Paperclip className="w-4.5 h-4.5 text-accent" />
          <h1 className="text-base font-semibold text-text">{t("sidebar.attachments")}</h1>
        </div>

        <div className="flex-1 max-w-md relative flex items-center gap-2">
          {aiSearchMode ? (
            <div className="flex-1 relative">
              <Sparkles className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-purple-500" />
              <input
                ref={aiInputRef}
                type="text"
                value={aiQuery}
                onChange={(e) => setAiQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleAiSearch(); if (e.key === "Escape") clearAiResults(); }}
                placeholder={t("attachments.aiSearchPlaceholder")}
                disabled={aiSearching}
                className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-purple-400/50 bg-purple-500/5 text-text text-sm focus:border-purple-500 transition-colors ring-1 ring-purple-400/20"
              />
            </div>
          ) : (
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("attachments.search")}
                className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-border bg-bg-secondary text-text text-sm focus:border-accent transition-colors"
              />
            </div>
          )}
          {appSettings.ai_enabled && (
            <button
              onClick={() => {
                if (aiSearchMode) {
                  clearAiResults();
                } else {
                  setAiSearchMode(true);
                  setTimeout(() => aiInputRef.current?.focus(), 50);
                }
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 ${
                aiSearchMode
                  ? "bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-400/30"
                  : "bg-bg-secondary text-text-tertiary border border-border hover:text-text-secondary hover:border-border-hover"
              }`}
              title={t("attachments.aiSearch")}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{t("attachments.aiSearch")}</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {selectedIds.size > 0 && (
            <>
              <span className="text-xs text-text-secondary">
                {t("attachments.selected", { count: selectedIds.size })}
              </span>
              <button
                onClick={handleBulkDownload}
                disabled={downloading}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
              >
                {downloading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                {t("attachments.downloadSelected")}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="px-6 py-2 border-b border-border no-select flex items-center gap-3">
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setAccountDropdownOpen((v) => !v)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
              selectedAccountIds.size > 0
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-border bg-bg-secondary text-text-secondary hover:border-border-hover"
            }`}
          >
            {selectedAccountIds.size === 1 && (
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: accounts.find((a) => a.id === Array.from(selectedAccountIds)[0])?.color || "var(--color-accent)" }}
              />
            )}
            <span className="truncate max-w-[140px]">{accountLabel}</span>
            <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${accountDropdownOpen ? "rotate-180" : ""}`} />
          </button>

          {accountDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 z-30 w-56 rounded-lg border border-border bg-surface shadow-lg py-1">
              <button
                onClick={() => {
                  setSelectedAccountIds(new Set());
                  setAccountDropdownOpen(false);
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs hover:bg-hover transition-colors ${
                  selectedAccountIds.size === 0 ? "text-accent font-medium" : "text-text"
                }`}
              >
                <span className={`w-4 h-4 rounded border-[1.5px] flex items-center justify-center shrink-0 ${
                  selectedAccountIds.size === 0 ? "border-accent bg-accent text-white" : "border-text-tertiary/40"
                }`}>
                  {selectedAccountIds.size === 0 && <Check className="w-2.5 h-2.5" />}
                </span>
                {t("attachments.allAccounts")}
              </button>

              <div className="border-t border-border my-1" />

              {accounts.map((account) => {
                const isChecked = selectedAccountIds.has(account.id);
                return (
                  <button
                    key={account.id}
                    onClick={() => toggleAccountFilter(account.id)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-text hover:bg-hover transition-colors"
                  >
                    <span className={`w-4 h-4 rounded border-[1.5px] flex items-center justify-center shrink-0 ${
                      isChecked ? "border-accent bg-accent text-white" : "border-text-tertiary/40"
                    }`}>
                      {isChecked && <Check className="w-2.5 h-2.5" />}
                    </span>
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: account.color || "#888" }}
                    />
                    <span className="truncate">{account.display_name || account.email}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="w-px h-5 bg-border" />

        <div className="flex items-center gap-1.5 flex-wrap">
          {fileTypeChips.map(({ key, label }) => {
            const isActive = selectedFileTypes.has(key);
            return (
              <button
                key={key}
                onClick={() => toggleFileType(key)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-accent/15 text-accent border border-accent/30"
                    : "bg-bg-secondary text-text-tertiary border border-transparent hover:text-text-secondary hover:bg-hover"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {totalCount != null && !loading && (
          <span className="ml-auto text-xs text-text-tertiary tabular-nums whitespace-nowrap">
            {t("attachments.resultCount", { count: totalCount })}
          </span>
        )}
      </div>

      {aiSearching && (
        <div className="px-6 py-2.5 border-b border-purple-300/30 bg-purple-500/5 flex items-center gap-2">
          <Loader2 className="w-4 h-4 text-purple-500 animate-spin" />
          <span className="text-xs text-purple-600 dark:text-purple-400 font-medium">{t("attachments.aiSearching")}</span>
        </div>
      )}
      {aiError && (
        <div className="px-6 py-2.5 border-b border-red-300/30 bg-red-500/5 flex items-center gap-2">
          <span className="text-xs text-red-600 dark:text-red-400">{t("attachments.aiError")}: {aiError}</span>
          <button onClick={clearAiResults} className="ml-auto text-xs text-red-500 hover:text-red-600 font-medium">
            {t("attachments.aiClearResults")}
          </button>
        </div>
      )}
      {aiResults && !aiError && (
        <div className="px-6 py-2.5 border-b border-purple-300/30 bg-purple-500/5 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-purple-500 shrink-0" />
          <span className="text-xs text-purple-600 dark:text-purple-400 font-medium">
            {aiResults.length === 0
              ? t("attachments.aiNoResults")
              : t("attachments.aiResults", { count: aiResults.length, query: aiParsedQuery })
            }
          </span>
          <button
            onClick={clearAiResults}
            className="ml-auto flex items-center gap-1 text-xs text-purple-500 hover:text-purple-600 dark:hover:text-purple-300 font-medium transition-colors"
          >
            <X className="w-3 h-3" />
            {t("attachments.aiClearResults")}
          </button>
        </div>
      )}

      {(loading && !aiResults) ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 text-accent animate-spin" />
        </div>
      ) : displayedAttachments.length === 0 ? (
        <EmptyState
          icon={<Paperclip className="w-10 h-10 text-text-tertiary" />}
          title={aiResults ? t("attachments.aiNoResults") : t("attachments.noResults")}
          description={aiResults ? "" : debouncedQuery ? t("attachments.noResultsQuery") : t("attachments.noAttachments")}
        />
      ) : (
        <div className="flex-1 flex min-h-0">
          <div ref={listRef} className="flex-1 min-w-0 overflow-auto" onScroll={handleScroll}>
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-bg-secondary/80 backdrop-blur-sm">
                <tr className="border-b border-border text-left text-xs text-text-tertiary uppercase tracking-wider">
                  <th className="w-10 pl-6 pr-1 py-2">
                    <button
                      onClick={toggleSelectAll}
                      className={`w-4 h-4 rounded border-[1.5px] flex items-center justify-center transition-colors ${
                        selectedIds.size > 0 && selectedIds.size === displayedAttachments.length
                          ? "border-accent bg-accent text-white"
                          : selectedIds.size > 0
                          ? "border-accent bg-accent/20 text-accent"
                          : "border-text-tertiary/40 hover:border-accent"
                      }`}
                    >
                      {selectedIds.size > 0 && selectedIds.size === displayedAttachments.length && <Check className="w-2.5 h-2.5" />}
                      {selectedIds.size > 0 && selectedIds.size < displayedAttachments.length && <span className="w-1.5 h-0.5 bg-accent rounded" />}
                    </button>
                  </th>
                  <th className="py-2 px-3">
                    <button onClick={() => handleSort("filename")} className="group/th flex items-center gap-1.5 hover:text-text transition-colors">
                      {t("attachments.colFilename")}
                      <SortIcon column="filename" activeSort={sortBy} activeOrder={sortOrder} />
                    </button>
                  </th>
                  <th className="py-2 px-3 w-24">
                    <button onClick={() => handleSort("size")} className="group/th flex items-center gap-1.5 hover:text-text transition-colors">
                      {t("attachments.colSize")}
                      <SortIcon column="size" activeSort={sortBy} activeOrder={sortOrder} />
                    </button>
                  </th>
                  <th className="py-2 px-3">{t("attachments.colFrom")}</th>
                  <th className="py-2 px-3">{t("attachments.colSubject")}</th>
                  <th className="py-2 px-3 w-32">{t("attachments.colFolder")}</th>
                  <th className="py-2 px-3 w-32 pr-6">
                    <button onClick={() => handleSort("date")} className="group/th flex items-center gap-1.5 hover:text-text transition-colors">
                      {t("attachments.colDate")}
                      <SortIcon column="date" activeSort={sortBy} activeOrder={sortOrder} />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayedAttachments.map((att) => {
                  const isSelected = selectedIds.has(att.id);
                  const isPreviewing = previewAttachment?.id === att.id;
                  return (
                    <tr
                      key={att.id}
                      className={`border-b border-border-light transition-colors hover:bg-hover cursor-pointer ${
                        isPreviewing ? "bg-accent/10" : isSelected ? "bg-accent/5" : ""
                      }`}
                      onClick={() => setPreviewAttachment(att)}
                      onDoubleClick={() => {
                        if (att.mime_type?.startsWith("image/") && att.local_path) {
                          openLightboxFor(att);
                        } else {
                          openMail(att);
                        }
                      }}
                    >
                      <td className="pl-6 pr-1 py-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelection(att.id);
                          }}
                          className={`w-4 h-4 rounded border-[1.5px] flex items-center justify-center transition-colors ${
                            isSelected
                              ? "border-accent bg-accent text-white"
                              : "border-text-tertiary/30 hover:border-accent"
                          }`}
                        >
                          {isSelected && <Check className="w-2.5 h-2.5" />}
                        </button>
                      </td>
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="shrink-0">{getFileIcon(att.mime_type, att.filename)}</span>
                          <span className="truncate font-medium text-text">{att.filename}</span>
                        </div>
                      </td>
                      <td className="py-2 px-3 text-text-tertiary tabular-nums">
                        {formatFileSize(att.size_bytes)}
                      </td>
                      <td className="py-2 px-3 text-text-secondary truncate max-w-[200px]">
                        {att.mail_from_name || att.mail_from_email}
                      </td>
                      <td className="py-2 px-3 text-text-secondary truncate max-w-[250px]">
                        {att.mail_subject}
                      </td>
                      <td className="py-2 px-3">
                        {att.folder_name && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-alt text-text-tertiary">
                            {att.folder_name}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 pr-6 text-text-tertiary whitespace-nowrap">
                        {formatMailDate(att.mail_date, appSettings.use_24h_clock)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {loadingMore && (
              <div className="flex justify-center py-3">
                <Loader2 className="w-4 h-4 animate-spin text-text-tertiary" />
              </div>
            )}
          </div>

          {previewAttachment && (
            <>
              <ResizeHandle onResize={handlePreviewResize} />
              <AttachmentPreview
                width={previewWidth}
                attachment={previewAttachment}
                onClose={() => setPreviewAttachment(null)}
                onDownload={handleSingleDownload}
                onOpenMail={openMail}
                onPrev={selectPrev}
                onNext={selectNext}
                hasPrev={hasPrev}
                hasNext={hasNext}
                onExpandImage={
                  previewAttachment.mime_type?.startsWith("image/") && previewAttachment.local_path
                    ? () => openLightboxFor(previewAttachment)
                    : undefined
                }
              />
            </>
          )}
        </div>
      )}

      {lightboxIndex !== null && (
        <ImageLightbox
          images={imageLightboxItems}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onDownload={handleLightboxDownload}
        />
      )}
    </div>
  );
}
