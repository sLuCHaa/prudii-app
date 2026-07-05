import { useEffect, useCallback, useState, useRef, useMemo, DragEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2, Paperclip, X, Star, Archive, Trash2, Mail as MailIcon, MailOpen, Check, Pin, Clock, CalendarClock, Inbox, Send, FileText, ShieldAlert, Folder } from "lucide-react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { FlagDots } from "../ui/FlagPicker";
import { GradientAvatar } from "../motion/GradientAvatar";
import { NumberTween } from "../motion/NumberTween";
import { MailContextMenu } from "../ui/MailContextMenu";
import gsap from "gsap";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../stores/appStore";
import type { FolderFilter } from "../../stores/appStore";
import { useMails, useFilteredMails, useAllInboxMails, useCombinedFolderMails, useSnoozedMails, useSplitInboxMails, useInboxSplits, useToggleStar, useTogglePin } from "../../hooks/useAccounts";
import { useSearchMails } from "../../hooks/useSync";
import { useScroller } from "../../hooks/useScroller";
import { trashMail, archiveMail, toggleRead, countCombinedFolderMails, emptyAllTrash, emptyAllSpam, batchUpdateMails, snoozeMail, listScheduledMails, cancelScheduledSend } from "../../lib/tauri";
import type { ScheduledMail, SearchResult } from "../../types";
import { useDialog } from "../ui/DialogProvider";
import { EmptyState, InboxZeroState, NoSearchResultsState } from "../ui/EmptyState";
import { incrementArchivedToday, recordInboxZeroDay } from "../../lib/achievements";
import { SearchBar } from "./SearchBar";
import { MagnifierIcon, StarIcon } from "../icons";
import { MailListSkeleton } from "../ui/MailListSkeleton";
import { LoadingCrossfade } from "../motion/LoadingCrossfade";
import { ENTRANCE, prefersReducedMotion } from "../motion/tokens";
import { formatMailDate, getDateGroup } from "../../lib/dateUtils";
import { runMailAction, toastError } from "../../lib/errorToast";
import { MAIL_FLAG_COLORS } from "../../types";
import type { Mail } from "../../types";
import { useTranslation } from "react-i18next";

function DragPreview({
  mail,
  position,
  grabOffset,
  width
}: {
  mail: Mail | null;
  position: { x: number; y: number };
  grabOffset: { x: number; y: number };
  width: number;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const appSettings = useAppStore((s) => s.appSettings);
  const { t } = useTranslation();

  useEffect(() => {
    if (!previewRef.current || !mail) return;

    gsap.fromTo(previewRef.current,
      { scale: 1, boxShadow: "0 4px 20px rgba(0,0,0,0.1)" },
      { scale: 1.02, boxShadow: "0 15px 35px rgba(0,0,0,0.25)", duration: 0.15, ease: "power2.out" }
    );
  }, [mail]);

  if (!mail) return null;

  return createPortal(
    <div
      ref={previewRef}
      className="fixed pointer-events-none z-9999"
      style={{
        // Position so the cursor stays where you grabbed it
        left: position.x - grabOffset.x,
        top: position.y - grabOffset.y,
        transform: "rotate(1deg)",
      }}
    >
      <div
        className="bg-surface border border-accent rounded-lg shadow-2xl px-4 py-3 relative overflow-hidden"
        style={{ width: width }}
      >
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-linear-to-r from-accent via-purple-500 to-accent" />

        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-0.5">
              <span className={`text-sm truncate ${!mail.is_read ? "font-semibold text-text" : "text-text-secondary"}`}>
                {mail.from.name || mail.from.email}
              </span>
              <span className="text-xs text-text-tertiary shrink-0 ml-2">
                {formatMailDate(mail.date, appSettings.use_24h_clock)}
              </span>
            </div>
            <div className={`text-sm truncate mb-0.5 ${!mail.is_read ? "font-medium text-text" : "text-text-secondary"}`}>
              {mail.subject || t("compose.noSubject")}
            </div>
            <div className="text-xs text-text-tertiary truncate">
              {mail.snippet}
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              {mail.is_starred && <StarIcon size={12} color="var(--c-warning)" />}
              {mail.has_attachments && <Paperclip className="w-3 h-3 text-text-tertiary" />}
            </div>
          </div>
        </div>
      </div>

      <div className="absolute inset-0 -z-10 bg-accent/30 blur-2xl rounded-lg scale-95 translate-y-2" />
    </div>,
    document.body
  );
}

function MailLoader() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const envelopeRef = useRef<SVGGElement>(null);
  const linesRef = useRef<SVGRectElement[]>([]);

  useEffect(() => {
    if (!containerRef.current || !envelopeRef.current) return;

    gsap.fromTo(envelopeRef.current,
      { y: 12, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.5, ease: "back.out(1.5)" }
    );

    linesRef.current.forEach((line, i) => {
      gsap.fromTo(line,
        { opacity: 0, scaleX: 0.5 },
        { opacity: 0.4, scaleX: 1, duration: 0.4, ease: "power2.out", delay: 0.3 + i * 0.1 }
      );
    });

    return () => {
      gsap.killTweensOf(envelopeRef.current);
      linesRef.current.forEach((line) => gsap.killTweensOf(line));
    };
  }, []);

  return (
    <div ref={containerRef} className="flex flex-col items-center justify-center py-16">
      <svg width="64" height="64" viewBox="0 0 64 64" className="text-accent mb-4">
        <g ref={envelopeRef}>
          {/* Envelope body */}
          <rect x="8" y="20" width="48" height="32" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
          {/* Envelope flap */}
          <path d="M8 24 L32 40 L56 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </g>
      </svg>

      {/* Shimmer lines */}
      <div className="space-y-2 w-48">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-2">
            <svg width="100%" height="8" className="text-text-tertiary">
              <rect
                ref={(el) => { if (el) linesRef.current[i] = el; }}
                x="0"
                y="0"
                width={`${80 - i * 15}%`}
                height="8"
                rx="4"
                fill="currentColor"
                opacity="0.2"
              />
            </svg>
          </div>
        ))}
      </div>

      <p className="text-sm text-text-tertiary mt-4">{t("mailList.loadingEmails")}</p>
    </div>
  );
}

function getEmptyIcon(folderType?: string, combinedFolder?: string | null, activeFilter?: string | null, showAllInboxes?: boolean): React.ReactNode {
  if (showAllInboxes) return <Inbox className="w-10 h-10" />;
  if (activeFilter === "starred") return <Star className="w-10 h-10" />;
  const type = folderType || combinedFolder || "default";
  switch (type) {
    case "inbox": return <Inbox className="w-10 h-10" />;
    case "sent": return <Send className="w-10 h-10" />;
    case "drafts": return <FileText className="w-10 h-10" />;
    case "trash": return <Trash2 className="w-10 h-10" />;
    case "spam": return <ShieldAlert className="w-10 h-10" />;
    case "archive": return <Archive className="w-10 h-10" />;
    case "custom": return <Folder className="w-10 h-10" />;
    default: return <Folder className="w-10 h-10" />;
  }
}

function ScheduledMailsView() {
  const { t } = useTranslation();
  const appSettings = useAppStore((s) => s.appSettings);
  const [scheduledMails, setScheduledMails] = useState<ScheduledMail[]>([]);
  const [loading, setLoading] = useState(true);
  const [scheduledLoaded, setScheduledLoaded] = useState(false);

  const fetchScheduled = useCallback(() => {
    listScheduledMails()
      .then((list) => {
        setScheduledMails(list);
        setScheduledLoaded(true);
      })
      .catch((e) => console.error("[listScheduledMails]", e))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchScheduled();
    const interval = setInterval(fetchScheduled, 30000);
    return () => clearInterval(interval);
  }, [fetchScheduled]);

  function handleCancel(draftId: string) {
    cancelScheduledSend(draftId)
      .then(() => {
        setScheduledMails((prev) => prev.filter((m) => m.id !== draftId));
      })
      .catch((e) => toastError(e, "errors.cancelScheduled"));
  }

  function formatScheduledDate(dateStr: string) {
    try {
      if (!dateStr) return "";
      const d = new Date(dateStr.replace(" ", "T") + "Z");
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleString(appSettings.language || "en", {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        hour12: !appSettings.use_24h_clock,
      });
    } catch {
      return dateStr;
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 text-accent animate-spin" />
      </div>
    );
  }

  if (!scheduledLoaded) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-text-tertiary">—</div>
      </div>
    );
  }

  if (scheduledMails.length === 0) {
    return (
      <EmptyState
        icon={<CalendarClock className="w-10 h-10 text-text-tertiary" />}
        title={t("scheduled.noScheduled")}
        description={t("scheduled.noScheduledDesc")}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      {scheduledMails.map((mail) => {
        const recipients = (() => { try { return (JSON.parse(mail.to_addresses) as string[]).join(", "); } catch { return mail.to_addresses; } })();
        return (
          <div key={mail.id} className="px-4 py-3 border-b border-border hover:bg-hover transition-colors">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text truncate">{mail.subject || t("compose.noSubject")}</p>
                <p className="text-xs text-text-tertiary truncate mt-0.5">{t("common.to")}: {recipients}</p>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <CalendarClock className="w-3.5 h-3.5 text-accent" />
                  <span className="text-xs text-accent font-medium">{formatScheduledDate(mail.scheduled_at)}</span>
                </div>
              </div>
              <button
                onClick={() => handleCancel(mail.id)}
                className="shrink-0 p-1.5 rounded-md hover:bg-danger/10 text-text-tertiary hover:text-danger transition-colors"
                title={t("scheduled.cancel")}
                aria-label={t("scheduled.cancel")}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Render text with [[hl]]...[[/hl]] markers as highlighted spans */
function HighlightedText({ text }: { text: string }) {
  if (!text) return null;
  const parts = text.split(/\[\[hl\]\]|\[\[\/hl\]\]/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-accent/30 text-text rounded-sm px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function SearchResultsList({ results, isLoading, selectedMailId, setSelectedMailId, appSettings }: {
  results: SearchResult[] | undefined;
  isLoading: boolean;
  selectedMailId: string | null;
  setSelectedMailId: (id: string | null) => void;
  appSettings: { use_24h_clock: boolean };
}) {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-5 h-5 text-accent animate-spin mx-auto mb-2" />
          <p className="text-sm text-text-tertiary">{t("common.searching")}</p>
        </div>
      </div>
    );
  }

  if (results && results.length === 0) {
    return <NoSearchResultsState query={useAppStore.getState().searchQuery} />;
  }

  if (!results) return null;

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      <div className="px-4 py-1.5 bg-surface sticky top-0 z-10 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary">
          {t("mailDetail.searchResults", { count: results.length, query: useAppStore.getState().searchQuery })}
        </span>
        <div className="flex-1 h-px bg-border" />
      </div>
      {results.map((result) => (
        <button
          key={result.mail_id}
          onClick={() => setSelectedMailId(result.mail_id)}
          style={{
            borderLeft: !result.is_read ? "2px solid var(--c-accent)" : "2px solid transparent",
          }}
          className={`w-full text-left px-4 py-2.5 border-b border-border-light transition-all hover:translate-x-0.5 ${
            selectedMailId === result.mail_id ? "bg-selected" : "hover:bg-hover"
          }`}
        >
          <div className="flex items-start gap-2.5">
            <div className="mt-1.5 shrink-0">
              <div className={`w-1.5 h-1.5 rounded-full ${!result.is_read ? "bg-accent" : "bg-transparent"}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-0.5">
                <span className={`text-sm truncate ${!result.is_read ? "font-semibold text-text" : "text-text-secondary"}`}>
                  {result.from_name || result.from_email}
                </span>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  {result.has_attachments && (
                    <Paperclip className="w-3 h-3 text-text-tertiary" />
                  )}
                  <span className="text-xs text-text-tertiary">
                    {formatMailDate(result.date, appSettings.use_24h_clock)}
                  </span>
                </div>
              </div>
              <div className={`text-sm mb-0.5 ${!result.is_read ? "font-medium text-text" : "text-text-secondary"}`}>
                {result.subject}
              </div>
              {result.snippet && (
                <div className="text-xs text-text-tertiary line-clamp-2 leading-relaxed">
                  <HighlightedText text={result.snippet} />
                </div>
              )}
              {result.folder_name && (
                <div className="mt-1">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-alt text-text-tertiary">
                    {result.folder_name}
                  </span>
                </div>
              )}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

type VirtualItem =
  | { kind: "separator"; group: string; label: string }
  | { kind: "mail"; mail: Mail; mailIndex: number };

interface VirtualMailListProps {
  listRef: React.RefObject<HTMLDivElement | null>;
  filteredMails: Mail[];
  selectedMailIndex: number;
  selectedMailId: string | null;
  selectedMailIds: Set<string>;
  multiSelectMode: boolean;
  appSettings: { use_24h_clock: boolean };
  dateGroupLabels: Record<string, string>;
  snoozeMenuId: string | null;
  setSnoozeMenuId: (id: string | null) => void;
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  handleListScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  handleMailClick: (e: React.MouseEvent, mail: Mail, index: number) => void;
  handleContextMenu: (e: React.MouseEvent, mail: Mail) => void;
  handleDragStart: (e: DragEvent<HTMLButtonElement>, mail: Mail) => void;
  handleDrag: (e: DragEvent<HTMLButtonElement>) => void;
  handleDragEnd: () => void;
  setMailItemRef: (id: string, el: HTMLButtonElement | null) => void;
  setMails: (updater: Mail[] | ((prev: Mail[]) => Mail[])) => void;
  toggleMailSelection: (id: string) => void;
  toggleStarMutation: { mutate: (id: string, opts?: { onError?: () => void }) => void };
  setPendingRemoveId: (id: string | null) => void;
  invalidateMailQueries: () => void;
  archiveMail: (id: string) => Promise<unknown>;
  trashMail: (id: string) => Promise<unknown>;
  snoozeMail: (id: string, until: string) => Promise<unknown>;
  onArchiveSuccess: (archivedIds: string[], preActionVisible: number) => void;
  t: (key: string) => string;
}

function VirtualMailList({
  listRef,
  filteredMails,
  selectedMailIndex,
  selectedMailId,
  selectedMailIds,
  multiSelectMode,
  appSettings,
  dateGroupLabels,
  snoozeMenuId,
  setSnoozeMenuId,
  hasNextPage,
  isFetchingNextPage,
  handleListScroll,
  handleMailClick,
  handleContextMenu,
  handleDragStart,
  handleDrag,
  handleDragEnd,
  setMailItemRef,
  setMails,
  toggleMailSelection,
  toggleStarMutation,
  setPendingRemoveId,
  invalidateMailQueries,
  archiveMail,
  trashMail,
  snoozeMail,
  onArchiveSuccess,
  t,
}: VirtualMailListProps) {
  // Themed overlay scrollbar on the virtualized list (keeps listRef as the
  // scroll viewport, so the virtualizer and onScroll keep working).
  useScroller(listRef);

  const virtualItems = useMemo<VirtualItem[]>(() => {
    const items: VirtualItem[] = [];
    let lastGroup = "";
    for (let i = 0; i < filteredMails.length; i++) {
      const mail = filteredMails[i];
      const group = getDateGroup(mail.date);
      if (group !== lastGroup) {
        lastGroup = group;
        items.push({ kind: "separator", group, label: dateGroupLabels[group] || group });
      }
      items.push({ kind: "mail", mail, mailIndex: i });
    }
    return items;
  }, [filteredMails, dateGroupLabels]);

  const rowVirtualizer = useVirtualizer({
    count: virtualItems.length + (hasNextPage || isFetchingNextPage ? 1 : 0),
    getScrollElement: () => listRef.current,
    estimateSize: (i) => {
      if (i >= virtualItems.length) return 40; // spinner row
      return virtualItems[i].kind === "separator" ? 32 : 68;
    },
    overscan: 8,
    measureElement: (el: Element) => el.getBoundingClientRect().height,
    // Stable per-item key so cached measurements stay tied to the right
    // item when the list mutates (mails archived/trashed/added). Without
    // this, the virtualizer keys by index → after a mutation, old heights
    // get applied to different items, causing overlaps and gaps.
    getItemKey: (i: number) => {
      if (i >= virtualItems.length) return "__spinner";
      const item = virtualItems[i];
      return item.kind === "separator" ? `sep-${item.group}` : item.mail.id;
    },
  });

  // Scroll selected mail into view when keyboard-navigating (j/k)
  useEffect(() => {
    if (selectedMailIndex < 0) return;
    const vIdx = virtualItems.findIndex(
      (it) => it.kind === "mail" && it.mailIndex === selectedMailIndex
    );
    if (vIdx >= 0) {
      rowVirtualizer.scrollToIndex(vIdx, { align: "auto" });
    }
  }, [selectedMailIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fade newly paginated rows in once. virtualItems grows when a next page
  // loads; rows whose virtual index is >= the previous count are "new". Guard
  // with a Set so re-virtualization during scroll never re-animates a row, and
  // clear it when the list shrinks (folder reload — handled by the entrance
  // staggers, not here).
  const prevItemCountRef = useRef(virtualItems.length);
  const animatedIndicesRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const prev = prevItemCountRef.current;
    const len = virtualItems.length;
    if (len < prev) {
      animatedIndicesRef.current.clear();
    }
    prevItemCountRef.current = len;
    if (prefersReducedMotion() || prev === 0 || len <= prev || !listRef.current) return;
    const nodes = listRef.current.querySelectorAll<HTMLElement>("[data-index]");
    nodes.forEach((node) => {
      const idx = Number(node.dataset.index);
      if (idx >= prev && idx < len && !animatedIndicesRef.current.has(idx)) {
        animatedIndicesRef.current.add(idx);
        // Opacity only: these are the virtualizer's absolutely-positioned
        // wrapper nodes whose `transform: translateY(start)` carries the row
        // position. Animating `y` here would clobber that transform and make
        // rows collapse/overlap. (The slide lives on the inner button entrance
        // staggers, which target elements without a position transform.)
        gsap.fromTo(
          node,
          { opacity: 0 },
          { opacity: 1, duration: ENTRANCE.duration, ease: ENTRANCE.ease }
        );
      }
    });
  }, [virtualItems.length, listRef]);

  return (
    <div
      ref={listRef}
      className="flex-1 overflow-y-auto"
      style={{ contain: "strict" }}
      onScroll={handleListScroll}
    >
      <div
        style={{
          height: rowVirtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((vRow) => {
          if (vRow.index >= virtualItems.length) {
            return (
              <div
                key="__spinner"
                data-index={vRow.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vRow.start}px)`,
                }}
                className="flex justify-center py-3"
              >
                {isFetchingNextPage && (
                  <Loader2 className="w-4 h-4 animate-spin text-text-tertiary" />
                )}
              </div>
            );
          }

          const item = virtualItems[vRow.index];

          if (item.kind === "separator") {
            return (
              <div
                key={`sep-${item.group}`}
                data-index={vRow.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vRow.start}px)`,
                  zIndex: 10,
                }}
                className="px-4 py-1.5 bg-surface flex items-center gap-2"
              >
                <span className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary">
                  {item.label}
                </span>
                <div className="flex-1 h-px bg-border" />
              </div>
            );
          }

          const { mail, mailIndex } = item;
          const isSelected = selectedMailIds.has(mail.id);

          return (
            <div
              key={mail.id}
              data-index={vRow.index}
              ref={rowVirtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vRow.start}px)`,
              }}
            >
              <button
                ref={(el) => setMailItemRef(mail.id, el)}
                onClick={(e) => handleMailClick(e, mail, mailIndex)}
                onContextMenu={(e) => handleContextMenu(e, mail)}
                draggable={!multiSelectMode}
                onDragStart={(e) => handleDragStart(e, mail)}
                onDrag={handleDrag}
                onDragEnd={handleDragEnd}
                className={`relative group/mail mail-item-draggable w-full text-left px-4 py-2.5 border-b border-border-light transition-all ${
                  isSelected
                    ? "bg-accent/15"
                    : selectedMailId === mail.id
                    ? "bg-selected"
                    : mailIndex === selectedMailIndex
                    ? "bg-hover"
                    : "hover:bg-hover"
                }`}
              >
                {/* Left stripe: gold = starred, blue = unread — fixed colors so the
                    two are always clearly distinguishable (independent of theme/account color). */}
                <div
                  aria-hidden
                  className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r"
                  style={{
                    background: mail.is_starred
                      ? "linear-gradient(180deg, #fbbf24 0%, #f59e0b 100%)"
                      : !mail.is_read
                        ? "#3b82f6"
                        : "transparent",
                  }}
                />
                <div className="flex items-start gap-3">
                  {multiSelectMode ? (
                    <div
                      className="shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleMailSelection(mail.id);
                      }}
                    >
                      <div
                        className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors ${
                          isSelected
                            ? "bg-accent text-white"
                            : "border-2 border-border-light hover:border-accent"
                        }`}
                      >
                        {isSelected && <Check className="w-3.5 h-3.5" />}
                      </div>
                    </div>
                  ) : (
                    <div className="relative shrink-0 group/check">
                      <GradientAvatar
                        name={mail.from.name}
                        email={mail.from.email}
                        size={36}
                        className="group-hover/check:invisible"
                      />
                      <div
                        className="absolute inset-0 invisible group-hover/check:visible flex items-center justify-center"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleMailSelection(mail.id);
                        }}
                      >
                        <div className="w-7 h-7 rounded-full border-2 border-border-light hover:border-accent flex items-center justify-center transition-colors" />
                      </div>
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span
                        className={`flex-1 min-w-0 truncate text-sm ${
                          !mail.is_read ? "font-semibold text-text" : "text-text-secondary"
                        }`}
                      >
                        {mail.from.name || mail.from.email}
                      </span>
                      <span className="shrink-0 text-xs text-text-tertiary tabular-nums">
                        {formatMailDate(mail.date, appSettings.use_24h_clock)}
                      </span>
                    </div>

                    <div className="mt-0.5 flex items-center gap-2">
                      <span
                        className={`flex-1 min-w-0 truncate text-sm ${
                          !mail.is_read ? "text-text" : "text-text-secondary"
                        }`}
                      >
                        {mail.subject || t("compose.noSubject")}
                      </span>
                      {(mail.is_pinned || mail.is_starred || (mail.flags && mail.flags.length > 0) || mail.has_attachments) && (
                        <span className="flex shrink-0 items-center gap-1.5 text-text-tertiary">
                          {mail.is_pinned && <Pin className="w-3 h-3 text-accent" />}
                          {mail.is_starred && <StarIcon size={12} color="var(--c-warning)" />}
                          {mail.flags && mail.flags.length > 0 && <FlagDots flags={mail.flags} size={9} />}
                          {mail.has_attachments && <Paperclip className="w-3 h-3" />}
                        </span>
                      )}
                    </div>

                    <div className="mt-0.5 truncate text-xs text-text-tertiary">{mail.snippet}</div>
                  </div>
                </div>
                {!multiSelectMode && (
                  <div
                    className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1 opacity-0 group-hover/mail:opacity-100 transition-opacity duration-150 pointer-events-none group-hover/mail:pointer-events-auto"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const preActionVisible = filteredMails.length;
                        setPendingRemoveId(mail.id);
                        runMailAction(() => archiveMail(mail.id), {
                          errorKey: "errors.archive",
                          invalidate: invalidateMailQueries,
                          onPendingClear: () => setPendingRemoveId(null),
                          onSuccess: () => onArchiveSuccess([mail.id], preActionVisible),
                        });
                      }}
                      className="w-7 h-7 rounded-md bg-surface hover:bg-hover border border-border flex items-center justify-center text-text-secondary"
                      title={t("mailDetail.archive")}
                      aria-label={t("mailDetail.archive")}
                    >
                      <Archive className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const prev = mail.is_starred;
                        setMails((prev_) =>
                          prev_.map((m) =>
                            m.id === mail.id ? { ...m, is_starred: !prev } : m
                          )
                        );
                        toggleStarMutation.mutate(mail.id, {
                          onError: () =>
                            setMails((prev_) =>
                              prev_.map((m) =>
                                m.id === mail.id ? { ...m, is_starred: prev } : m
                              )
                            ),
                        });
                      }}
                      className="w-7 h-7 rounded-md bg-surface hover:bg-hover border border-border flex items-center justify-center"
                      title={t("mailDetail.star")}
                      aria-label={t("mailDetail.star")}
                    >
                      <Star className={`w-3.5 h-3.5 ${mail.is_starred ? "text-warning fill-warning" : "text-text-secondary"}`} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingRemoveId(mail.id);
                        runMailAction(() => trashMail(mail.id), {
                          errorKey: "errors.trash",
                          invalidate: invalidateMailQueries,
                          onPendingClear: () => setPendingRemoveId(null),
                        });
                      }}
                      className="w-7 h-7 rounded-md bg-surface hover:bg-hover border border-border flex items-center justify-center text-danger"
                      title={t("mailDetail.trash")}
                      aria-label={t("mailDetail.trash")}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                    <div className="relative">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSnoozeMenuId(snoozeMenuId === mail.id ? null : mail.id);
                        }}
                        className="w-7 h-7 rounded-md bg-surface hover:bg-hover border border-border flex items-center justify-center text-text-secondary"
                        title={t("snooze.snooze")}
                        aria-label={t("snooze.snooze")}
                      >
                        <Clock className="w-3.5 h-3.5" />
                      </button>
                      <AnimatePresence>
                        {snoozeMenuId === mail.id && (
                          <motion.div
                            initial={{ opacity: 0, y: -6, scale: 0.96 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: -6, scale: 0.96 }}
                            transition={{ duration: 0.14, ease: "easeOut" }}
                            className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-lg z-50 py-1 min-w-[160px] origin-top-right"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {[
                              {
                                label: t("snooze.in1Hour"),
                                getDate: () => {
                                  const d = new Date();
                                  d.setHours(d.getHours() + 1);
                                  return d;
                                },
                              },
                              {
                                label: t("snooze.tomorrowMorning"),
                                getDate: () => {
                                  const d = new Date();
                                  d.setDate(d.getDate() + 1);
                                  d.setHours(9, 0, 0, 0);
                                  return d;
                                },
                              },
                              {
                                label: t("snooze.nextMonday"),
                                getDate: () => {
                                  const d = new Date();
                                  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
                                  d.setHours(9, 0, 0, 0);
                                  return d;
                                },
                              },
                            ].map((preset) => (
                              <button
                                key={preset.label}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const until = preset.getDate();
                                  const formatted = `${until.getFullYear()}-${String(until.getMonth() + 1).padStart(2, "0")}-${String(until.getDate()).padStart(2, "0")} ${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}:${String(until.getSeconds()).padStart(2, "0")}`;
                                  setPendingRemoveId(mail.id);
                                  runMailAction(() => snoozeMail(mail.id, formatted), {
                                    errorKey: "errors.snooze",
                                    invalidate: invalidateMailQueries,
                                    onPendingClear: () => setPendingRemoveId(null),
                                  });
                                  setSnoozeMenuId(null);
                                }}
                                className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-hover transition-colors"
                              >
                                {preset.label}
                              </button>
                            ))}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MailList() {
  const {
    selectedFolderId,
    selectedMailId,
    setSelectedMailId,
    selectedMailIndex,
    setSelectedMailIndex,
    mails,
    setMails,
    appSettings,
    activeFilter,
    setActiveFilter,
    showAllInboxes,
    setShowAllInboxes,
    activeCombinedFolder,
    setActiveCombinedFolder,
    activeSplitId,
    setActiveSplitId,
    showSnoozed,
    showScheduled,
    folders,
    pendingRemoveId,
    setPendingRemoveId,
    openCompose,
    folderFilter,
    setFolderFilter,
    selectedMailIds,
    multiSelectMode,
    toggleMailSelection,
    selectMailRange,
    selectAllMails,
    clearSelection,
  } = useAppStore(useShallow((s) => ({
    selectedFolderId: s.selectedFolderId,
    selectedMailId: s.selectedMailId,
    setSelectedMailId: s.setSelectedMailId,
    selectedMailIndex: s.selectedMailIndex,
    setSelectedMailIndex: s.setSelectedMailIndex,
    mails: s.mails,
    setMails: s.setMails,
    appSettings: s.appSettings,
    activeFilter: s.activeFilter,
    setActiveFilter: s.setActiveFilter,
    showAllInboxes: s.showAllInboxes,
    setShowAllInboxes: s.setShowAllInboxes,
    activeCombinedFolder: s.activeCombinedFolder,
    setActiveCombinedFolder: s.setActiveCombinedFolder,
    activeSplitId: s.activeSplitId,
    setActiveSplitId: s.setActiveSplitId,
    showSnoozed: s.showSnoozed,
    showScheduled: s.showScheduled,
    folders: s.folders,
    pendingRemoveId: s.pendingRemoveId,
    setPendingRemoveId: s.setPendingRemoveId,
    openCompose: s.openCompose,
    folderFilter: s.folderFilter,
    setFolderFilter: s.setFolderFilter,
    selectedMailIds: s.selectedMailIds,
    multiSelectMode: s.multiSelectMode,
    toggleMailSelection: s.toggleMailSelection,
    selectMailRange: s.selectMailRange,
    selectAllMails: s.selectAllMails,
    clearSelection: s.clearSelection,
  })));

  const { t } = useTranslation();
  const searchOpen = useAppStore((s) => s.searchOpen);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);
  const searchQuery = useAppStore((s) => s.searchQuery);
  // Full-text search spans all accounts and folders — don't scope to selected account
  const searchResults = useSearchMails(searchOpen ? searchQuery : "");
  const queryClient = useQueryClient();
  /** Invalidate folder counts + all combined/inbox queries so every view stays fresh. */
  const invalidateMailQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["folders"] });
    queryClient.invalidateQueries({ queryKey: ["mails"] });
    queryClient.invalidateQueries({ queryKey: ["filtered-mails"] });
    queryClient.invalidateQueries({ queryKey: ["all-inbox-mails"] });
    queryClient.invalidateQueries({ queryKey: ["combined-folder-mails"] });
    queryClient.invalidateQueries({ queryKey: ["split-inbox-mails"] });
  }, [queryClient]);
  const dialog = useDialog();
  const [contextMenu, setContextMenu] = useState<{ mail: Mail; x: number; y: number } | null>(null);
  const [snoozeMenuId, setSnoozeMenuId] = useState<string | null>(null);
  const [draggingMail, setDraggingMail] = useState<Mail | null>(null);
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
  const [grabOffset, setGrabOffset] = useState({ x: 0, y: 0 });
  const [dragItemWidth, setDragItemWidth] = useState(320);
  const mailItemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const listRef = useRef<HTMLDivElement>(null);
  const wasLoadingRef = useRef(false);

  // Handle drag event to track position (mousemove doesn't work during HTML5 drag)
  const handleDrag = useCallback((e: DragEvent<HTMLButtonElement>) => {
    // During drag, clientX/clientY can be 0 at the end - ignore those
    if (e.clientX !== 0 && e.clientY !== 0) {
      setDragPosition({ x: e.clientX, y: e.clientY });
    }
  }, []);

  const handleDragStart = useCallback((e: DragEvent<HTMLButtonElement>, mail: Mail) => {
    e.dataTransfer.setData("application/x-mail-id", mail.id);
    e.dataTransfer.setData("application/x-mail-account-id", mail.account_id);
    e.dataTransfer.effectAllowed = "move";

    // Use transparent image as native drag preview (we show our own)
    const img = new Image();
    img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    e.dataTransfer.setDragImage(img, 0, 0);

    const itemEl = mailItemRefs.current.get(mail.id);
    if (itemEl) {
      const rect = itemEl.getBoundingClientRect();
      setGrabOffset({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
      setDragItemWidth(rect.width);

      gsap.to(itemEl, {
        opacity: 0.15,
        scale: 0.98,
        duration: 0.15,
        ease: "power2.out",
      });
    }

    setDragPosition({ x: e.clientX, y: e.clientY });
    setDraggingMail(mail);
  }, []);

  const handleDragEnd = useCallback(() => {
    if (draggingMail) {
      const itemEl = mailItemRefs.current.get(draggingMail.id);
      if (itemEl) {
        gsap.to(itemEl, {
          scale: 1,
          opacity: 1,
          duration: 0.3,
          ease: "back.out(1.7)",
        });
      }
    }
    setDraggingMail(null);
  }, [draggingMail]);

  // Clear drag state if the dragging mail was removed from the list (e.g., optimistic drop)
  useEffect(() => {
    if (draggingMail && !mails.some((m) => m.id === draggingMail.id)) {
      setDraggingMail(null);
    }
  }, [mails, draggingMail]);

  const setMailItemRef = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) {
      mailItemRefs.current.set(id, el);
    } else {
      mailItemRefs.current.delete(id);
    }
  }, []);

  // Folder filter key: pass to backend for server-side filtering (skip "all")
  const activeFilterKey = folderFilter !== "all" ? folderFilter : undefined;

  const folderQuery = useMails(
    !activeFilter && !showAllInboxes && !activeCombinedFolder ? selectedFolderId : null,
    activeFilterKey
  );
  // Filters search across ALL accounts (no accountId filter)
  const filterQuery = useFilteredMails(
    activeFilter,
    undefined,
    activeFilterKey
  );
  const allInboxQuery = useAllInboxMails(showAllInboxes && !activeSplitId, activeFilterKey);
  const combinedQuery = useCombinedFolderMails(activeCombinedFolder, activeFilterKey);
  const snoozedQuery = useSnoozedMails(showSnoozed);
  const splitQuery = useSplitInboxMails(showAllInboxes ? activeSplitId : null);
  const splitsQuery = useInboxSplits();
  const inboxSplits = splitsQuery.data ?? [];

  const activeQuery = showSnoozed ? snoozedQuery : activeCombinedFolder ? combinedQuery : (showAllInboxes && activeSplitId) ? splitQuery : showAllInboxes ? allInboxQuery : activeFilter ? filterQuery : folderQuery;
  const isLoading = activeQuery.isLoading;
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = activeQuery;

  // activeQuery.data is referentially stable between re-renders (TanStack Query guarantee)
  // so useMemo only recomputes when actual query data changes, not on every store re-render
  const queryData = activeQuery.data;
  const fetchedMails = useMemo(() => {
    const flat = queryData?.pages.flat() ?? [];
    // Two-pass dedup:
    // 1. By message_id (same-source duplicates)
    // 2. By subject+date+from (cross-account duplicates)
    const seenIds = new Set<string>();
    const seenContent = new Set<string>();
    return flat.filter((m) => {
      const idKey = m.message_id || m.id;
      if (seenIds.has(idKey)) return false;
      seenIds.add(idKey);
      const contentKey = `${m.subject.toLowerCase().trim()}|${m.date}|${m.from.email.toLowerCase()}`;
      if (seenContent.has(contentKey)) return false;
      seenContent.add(contentKey);
      return true;
    });
  }, [queryData]);


  useEffect(() => {
    setMails(fetchedMails);
  }, [fetchedMails, setMails]);

  // Infinite scroll handler — called directly via onScroll prop (no stale closures)
  const handleListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (!hasNextPage || isFetchingNextPage) return;
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 300) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const combinedFolderLabels: Record<string, string> = useMemo(() => ({
    inbox: t("sidebar.allInboxes"),
    sent: t("sidebar.allSent"),
    drafts: t("sidebar.allDrafts"),
    trash: t("sidebar.allTrash"),
    spam: t("sidebar.allSpam"),
    archive: t("sidebar.allArchive"),
  }), [t]);

  const viewTitle = useMemo(() => {
    if (showScheduled) return t("scheduled.scheduled");
    if (showSnoozed) return t("snooze.snoozed");
    if (activeCombinedFolder) return combinedFolderLabels[activeCombinedFolder] || activeCombinedFolder;
    if (showAllInboxes) return t("sidebar.allInboxes");
    if (activeFilter) {
      if (activeFilter === "starred") return t("sidebar.starred");
      return t(MAIL_FLAG_COLORS[activeFilter]?.nameKey || activeFilter);
    }
    if (selectedFolderId) {
      const selectedFolder = folders.find((f) => f.id === selectedFolderId);
      if (selectedFolder) return selectedFolder.name;
    }
    return t("mailList.inbox");
  }, [activeFilter, showAllInboxes, showSnoozed, showScheduled, activeCombinedFolder, selectedFolderId, folders, t, combinedFolderLabels]);

  // Total count: use folder.total_count for folder view, loaded count otherwise.
  // Fallback to mails.length if total_count is 0 but mails are visible (stale count during sync).
  const totalCount = useMemo(() => {
    if (!activeFilter && !showAllInboxes && !activeCombinedFolder && selectedFolderId) {
      const folder = folders.find((f) => f.id === selectedFolderId);
      if (folder && folder.total_count > 0) return folder.total_count;
      if (folder && mails.length > 0) return mails.length;
      if (folder) return folder.total_count;
    }
    return mails.length;
  }, [activeFilter, showAllInboxes, selectedFolderId, folders, mails.length]);

  // Server-side filtering via query params — filteredMails is just mails
  const filteredMails = mails;

  const toggleStarMutation = useToggleStar();
  const togglePinMutation = useTogglePin();

  const dateGroupLabels: Record<string, string> = useMemo(() => ({
    today: t("dateGroups.today"),
    yesterday: t("dateGroups.yesterday"),
    thisWeek: t("dateGroups.thisWeek"),
    thisMonth: t("dateGroups.thisMonth"),
    older: t("dateGroups.older"),
  }), [t]);

  const currentFolder = folders.find((f) => f.id === selectedFolderId);
  const isDraftsFolder = currentFolder?.folder_type === "drafts" || activeCombinedFolder === "drafts";
  const canEmptyAll = activeCombinedFolder === "trash" || activeCombinedFolder === "spam";

  const handleEmptyAll = useCallback(async () => {
    if (!activeCombinedFolder) return;
    const isTrash = activeCombinedFolder === "trash";
    const folderName = isTrash ? t("folder.types.trash") : t("folder.types.spam");

    let mailCount: number;
    try {
      mailCount = await countCombinedFolderMails(activeCombinedFolder);
    } catch (e) {
      toastError(e, "errors.countFolderMails");
      return;
    }

    const confirmed = await dialog.danger({
      title: t("folder.emptyConfirmTitle", { name: folderName }),
      message: t("folder.emptyConfirmMessage", { count: mailCount, name: folderName }),
      confirmLabel: t("folder.emptyConfirmButton"),
      cancelLabel: t("common.cancel"),
    });

    if (!confirmed) return;

    try {
      const count = isTrash ? await emptyAllTrash() : await emptyAllSpam();
      queryClient.invalidateQueries({ queryKey: ["mails"] });
      queryClient.invalidateQueries({ queryKey: ["filtered-mails"] });
      queryClient.invalidateQueries({ queryKey: ["all-inbox-mails"] });
      queryClient.invalidateQueries({ queryKey: ["combined-folder-mails"] });
      invalidateMailQueries();

      await dialog.alert({
        type: "success",
        title: t("folder.emptiedTitle", { name: folderName }),
        message: t("folder.emptiedMessage", { count }),
      });
    } catch (err) {
      await dialog.alert({
        type: "danger",
        title: t("common.error"),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [activeCombinedFolder, mails.length, t, dialog, queryClient]);

  const handleContextMenu = useCallback((e: React.MouseEvent, mail: Mail) => {
    e.preventDefault();
    setContextMenu({ mail, x: e.clientX, y: e.clientY });
  }, []);

  /**
   * Call after each successful archive action.
   * Increments the "archived today" counter and, when the inbox just hit zero,
   * records a streak day and fires the inbox-zero toast.
   *
   * @param archivedIds IDs of the mails that were just archived
   * @param preActionVisible number of mails visible BEFORE the action — used to
   *   detect the > 0 → 0 transition and avoid false positives when the inbox
   *   was already empty.
   */
  const handleArchiveSuccess = useCallback(
    (archivedIds: string[], preActionVisible: number) => {
      for (let i = 0; i < archivedIds.length; i++) {
        incrementArchivedToday();
      }

      // Only fire inbox-zero toast when we're in an inbox view and the action
      // caused the transition from > 0 mails to 0 mails.
      const s = useAppStore.getState();
      const isInboxView =
        (currentFolder?.folder_type === "inbox" || s.showAllInboxes) &&
        !s.activeFilter &&
        s.folderFilter === "all";

      if (!isInboxView) return;
      if (preActionVisible <= 0) return; // already empty before — no celebration

      // Compute post-action remaining: exclude the archived IDs from the current
      // store snapshot (handles both optimistic and non-optimistic callsites).
      const archivedSet = new Set(archivedIds);
      const remaining = s.mails.filter((m) => !archivedSet.has(m.id)).length;

      if (remaining === 0) {
        const streak = recordInboxZeroDay();
        s.addToast(
          "success",
          t("achievements.inboxZeroToast"),
          streak > 1 ? t("achievements.streakDays", { days: streak }) : undefined,
        );
      }
    },
    [currentFolder, t],
  );

  const selectMail = useCallback(
    (index: number) => {
      if (index >= 0 && index < filteredMails.length) {
        const mail = filteredMails[index];
        setSelectedMailIndex(index);
        if (isDraftsFolder) {
          openCompose("draft", mail);
        } else {
          setSelectedMailId(mail.id);
        }
      }
    },
    [filteredMails, setSelectedMailId, setSelectedMailIndex, isDraftsFolder, openCompose]
  );

  const handleMailClick = useCallback(
    (e: React.MouseEvent, mail: Mail, index: number) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        toggleMailSelection(mail.id);
      } else if (e.shiftKey && multiSelectMode) {
        e.preventDefault();
        selectMailRange(mail.id, filteredMails);
      } else if (multiSelectMode) {
        toggleMailSelection(mail.id);
      } else {
        selectMail(index);
      }
    },
    [multiSelectMode, toggleMailSelection, selectMailRange, filteredMails, selectMail]
  );

  const isSearchActive = searchOpen && searchQuery.length >= 2;
  const searchResultsData = searchResults.data;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      // Allow ArrowUp/ArrowDown in the search input for navigating results
      if (target.tagName === "INPUT" && isSearchActive && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
        // fall through to handle navigation
      } else if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      if (isSearchActive && searchResultsData && searchResultsData.length > 0) {
        if (e.key === "j" || e.key === "ArrowDown") {
          e.preventDefault();
          const currentIdx = searchResultsData.findIndex((r) => r.mail_id === selectedMailId);
          const nextIdx = Math.min(currentIdx + 1, searchResultsData.length - 1);
          setSelectedMailId(searchResultsData[nextIdx].mail_id);
        } else if (e.key === "k" || e.key === "ArrowUp") {
          e.preventDefault();
          const currentIdx = searchResultsData.findIndex((r) => r.mail_id === selectedMailId);
          const prevIdx = Math.max(currentIdx - 1, 0);
          setSelectedMailId(searchResultsData[prevIdx].mail_id);
        } else if (e.key === "Enter") {
          e.preventDefault();
          // Already selected via j/k, Enter is a no-op (mail already shown on the right)
        }
        return;
      }

      if (e.key === "Escape" && multiSelectMode) {
        e.preventDefault();
        clearSelection();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        selectAllMails(filteredMails.map((m) => m.id));
        return;
      }

      if (e.key === "Delete" && multiSelectMode && selectedMailIds.size > 0) {
        e.preventDefault();
        const ids = Array.from(selectedMailIds);
        setMails(mails.filter((m) => !selectedMailIds.has(m.id)));
        clearSelection();
        runMailAction(() => batchUpdateMails(ids, "trash"), {
          errorKey: "errors.batchUpdate",
          invalidate: invalidateMailQueries,
        });
        return;
      }

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        selectMail(Math.min(selectedMailIndex + 1, filteredMails.length - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        selectMail(Math.max(selectedMailIndex - 1, 0));
      } else if (e.key === "Enter" && selectedMailIndex >= 0) {
        e.preventDefault();
        setSelectedMailId(filteredMails[selectedMailIndex].id);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filteredMails, selectedMailIndex, selectMail, setSelectedMailId, multiSelectMode, selectedMailIds, clearSelection, selectAllMails, setMails, mails, isSearchActive, searchResultsData, selectedMailId]);

  useEffect(() => {
    if (!listRef.current || isLoading || prefersReducedMotion()) return;
    const items = Array.from(listRef.current.querySelectorAll("button.mail-item-draggable")).slice(0, 20);
    if (items.length === 0) return;
    gsap.fromTo(items,
      { opacity: 0, y: ENTRANCE.y },
      { opacity: 1, y: 0, stagger: ENTRANCE.stagger, duration: ENTRANCE.duration, ease: ENTRANCE.ease }
    );
  }, [selectedFolderId, activeFilter, showAllInboxes, activeCombinedFolder, showSnoozed, activeSplitId]);

  useEffect(() => {
    if (!snoozeMenuId) return;
    function handleClick() { setSnoozeMenuId(null); }
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [snoozeMenuId]);

  useEffect(() => {
    if (wasLoadingRef.current && !isLoading && listRef.current && !prefersReducedMotion()) {
      const items = Array.from(listRef.current.querySelectorAll("button.mail-item-draggable")).slice(0, 20);
      if (items.length > 0) {
        gsap.fromTo(items,
          { opacity: 0, y: ENTRANCE.y },
          { opacity: 1, y: 0, stagger: ENTRANCE.stagger, duration: ENTRANCE.duration, ease: ENTRANCE.ease }
        );
      }
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    if (!pendingRemoveId) return;
    const el = mailItemRefs.current.get(pendingRemoveId);
    const removeId = pendingRemoveId;

    if (el) {
      gsap.to(el, {
        opacity: 0, x: -40, height: 0, paddingTop: 0, paddingBottom: 0,
        duration: 0.25, ease: "power2.in",
        onComplete: () => {
          const { mails: currentMails, selectedMailIndex: idx } = useAppStore.getState();
          const remaining = currentMails.filter((m) => m.id !== removeId);
          if (remaining.length === 0) {
            setSelectedMailId(null);
          } else {
            const nextIndex = Math.min(idx, remaining.length - 1);
            setSelectedMailId(remaining[nextIndex].id);
          }
          setMails(remaining);
          setPendingRemoveId(null);
        },
      });
    } else {
      // Element not found (e.g., already removed), fallback: just remove
      const remaining = mails.filter((m) => m.id !== removeId);
      if (remaining.length === 0) {
        setSelectedMailId(null);
      } else {
        const nextIndex = Math.min(selectedMailIndex, remaining.length - 1);
        setSelectedMailId(remaining[nextIndex].id);
      }
      setMails(remaining);
      setPendingRemoveId(null);
    }
  }, [pendingRemoveId]);

  if (!selectedFolderId && !activeFilter && !showAllInboxes && !activeCombinedFolder && !showSnoozed && !showScheduled) {
    return (
      <EmptyState title={t("mailList.selectFolder")} description={t("mailList.selectFolderDesc")} />
    );
  }

  return (
    <div className="flex flex-col h-full bg-surface">
      {multiSelectMode && selectedMailIds.size > 0 ? (
        <div className="px-4 py-2.5 border-b border-border no-select flex items-center justify-between bg-accent/5">
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (selectedMailIds.size === filteredMails.length) {
                  clearSelection();
                } else {
                  selectAllMails(filteredMails.map((m) => m.id));
                }
              }}
              className="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors border-accent bg-accent text-white"
            >
              {selectedMailIds.size === filteredMails.length ? (
                <Check className="w-3 h-3" />
              ) : (
                <span className="w-2 h-0.5 bg-white rounded" />
              )}
            </button>
            <span className="text-sm font-medium text-text flex items-baseline gap-1">
              <span className="tabular-nums font-bold">
                <NumberTween from={0} to={selectedMailIds.size} duration={250} />
              </span>
              <span className="text-text-secondary">{t("mailList.selectedSuffix")}</span>
            </span>
            <button
              onClick={clearSelection}
              className="p-0.5 rounded hover:bg-hover transition-colors text-text-tertiary"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => {
                const ids = Array.from(selectedMailIds);
                setMails((prev) => prev.map((m) => selectedMailIds.has(m.id) ? { ...m, is_read: true } : m));
                clearSelection();
                runMailAction(() => batchUpdateMails(ids, "mark_read"), {
                  errorKey: "errors.markAllRead",
                  invalidate: invalidateMailQueries,
                });
              }}
              className="p-1.5 rounded-lg hover:bg-hover transition-colors text-text-secondary hover:text-accent"
              title={t("mailList.markAllRead")}
              aria-label={t("mailList.markAllRead")}
            >
              <MailOpen className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                const ids = Array.from(selectedMailIds);
                setMails((prev) => prev.map((m) => selectedMailIds.has(m.id) ? { ...m, is_read: false } : m));
                clearSelection();
                runMailAction(() => batchUpdateMails(ids, "mark_unread"), {
                  errorKey: "errors.markAllRead",
                  invalidate: invalidateMailQueries,
                });
              }}
              className="p-1.5 rounded-lg hover:bg-hover transition-colors text-text-secondary hover:text-accent"
              title={t("mailList.markAllUnread")}
              aria-label={t("mailList.markAllUnread")}
            >
              <MailIcon className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                const ids = Array.from(selectedMailIds);
                setMails((prev) => prev.map((m) => selectedMailIds.has(m.id) ? { ...m, is_starred: true } : m));
                clearSelection();
                runMailAction(() => batchUpdateMails(ids, "star"), {
                  errorKey: "errors.batchUpdate",
                  invalidate: invalidateMailQueries,
                });
              }}
              className="p-1.5 rounded-lg hover:bg-hover transition-colors text-text-secondary hover:text-warning"
              title={t("mailDetail.star")}
              aria-label={t("mailDetail.star")}
            >
              <Star className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                const ids = Array.from(selectedMailIds);
                setMails(mails.filter((m) => !selectedMailIds.has(m.id)));
                clearSelection();
                runMailAction(() => batchUpdateMails(ids, "archive"), {
                  errorKey: "errors.batchUpdate",
                  invalidate: invalidateMailQueries,
                });
              }}
              className="p-1.5 rounded-lg hover:bg-hover transition-colors text-text-secondary hover:text-accent"
              title={t("mailDetail.archive")}
              aria-label={t("mailDetail.archive")}
            >
              <Archive className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                const ids = Array.from(selectedMailIds);
                setMails(mails.filter((m) => !selectedMailIds.has(m.id)));
                clearSelection();
                runMailAction(() => batchUpdateMails(ids, "trash"), {
                  errorKey: "errors.batchUpdate",
                  invalidate: invalidateMailQueries,
                });
              }}
              className="p-1.5 rounded-lg hover:bg-hover transition-colors text-text-secondary hover:text-danger"
              title={t("mailDetail.trash")}
              aria-label={t("mailDetail.trash")}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 py-2 border-b border-border no-select flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div>
              <div className="flex items-center gap-2">
                {isSearchActive ? (
                  <>
                    <MagnifierIcon size={14} strokeWidth={1.5} className="text-accent" />
                    <h2 className="text-sm font-semibold text-text">
                      {t("mailList.search")}
                    </h2>
                    {searchResultsData && (
                      <span className="text-xs text-text-tertiary">· {searchResultsData.length}</span>
                    )}
                  </>
                ) : (
                  <>
                    <h2 className="text-sm font-semibold text-text">
                      {viewTitle}
                    </h2>
                    {(activeFilter || showAllInboxes || activeCombinedFolder || showSnoozed || showScheduled) && (
                      <button
                        onClick={() => {
                          setActiveFilter(null);
                          setShowAllInboxes(false);
                          setActiveCombinedFolder(null);
                          if (showSnoozed) useAppStore.getState().setShowSnoozed(false);
                          if (showScheduled) useAppStore.getState().setShowScheduled(false);
                        }}
                        className="p-0.5 rounded hover:bg-hover transition-colors text-text-tertiary"
                        title={t("mailList.clear")}
                        aria-label={t("mailList.clear")}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                    <span className="text-xs text-text-tertiary">· {totalCount}</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {canEmptyAll && mails.length > 0 && (
              <button
                onClick={handleEmptyAll}
                className="px-2 py-1 rounded-lg text-xs font-medium text-danger hover:bg-danger/10 transition-colors"
              >
                {t("mailList.emptyAll")}
              </button>
            )}
            <button
              onClick={() => setSearchOpen(true)}
              className="p-1.5 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
              title={t("mailList.search")}
              aria-label={t("mailList.search")}
            >
              <MagnifierIcon size={16} strokeWidth={1.5} />
            </button>
          </div>
        </div>
      )}

      {showAllInboxes && inboxSplits.length > 0 && useAppStore.getState().hasFeature("split_inbox") && (
        <div className="px-4 py-1.5 border-b border-border-light flex items-center gap-1 no-select overflow-x-auto scrollbar-thin">
          <button
            onClick={() => setActiveSplitId(null)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              !activeSplitId
                ? "bg-accent/15 text-accent"
                : "text-text-tertiary hover:bg-hover hover:text-text-secondary"
            }`}
          >
            {t("mailList.filterAll")}
          </button>
          {inboxSplits.map((split) => (
            <button
              key={split.id}
              onClick={() => setActiveSplitId(split.id)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                activeSplitId === split.id
                  ? "bg-accent/15 text-accent"
                  : "text-text-tertiary hover:bg-hover hover:text-text-secondary"
              }`}
            >
              {split.icon && <span className="text-sm">{split.icon}</span>}
              {split.name}
            </button>
          ))}
        </div>
      )}

      {!(searchOpen && searchQuery.length >= 2) && (
        <div className="px-4 py-1 flex items-center gap-1 no-select bg-bg-secondary/50">
          {(["all", "unread", "starred", "attachments"] as FolderFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFolderFilter(f)}
              className={`px-2.5 py-0.5 rounded-full text-xs font-medium transition-colors ${
                folderFilter === f
                  ? "bg-accent/15 text-accent"
                  : "text-text-tertiary hover:bg-hover hover:text-text-secondary"
              }`}
            >
              {t(`mailList.filter${f.charAt(0).toUpperCase() + f.slice(1)}`)}
            </button>
          ))}
        </div>
      )}

      <SearchBar />

      {searchOpen && searchQuery.length >= 2 ? (
        <SearchResultsList
          results={searchResults.data}
          isLoading={searchResults.isLoading}
          selectedMailId={selectedMailId}
          setSelectedMailId={setSelectedMailId}
          appSettings={appSettings}
        />
      ) : showScheduled ? (
        <ScheduledMailsView />
      ) : (
        <LoadingCrossfade
          loading={isLoading}
          skeleton={<MailListSkeleton count={12} />}
          className="flex flex-col flex-1 min-h-0"
        >
          {filteredMails.length === 0 && !searchOpen ? (
            (() => {
              const isInboxView = (currentFolder?.folder_type === "inbox" || showAllInboxes)
                && !activeFilter
                && folderFilter === "all";
              if (isInboxView) {
                return <InboxZeroState />;
              }
              // Folder-type-specific empty text, falling back to the generic
              // `default` key for any type without its own string (e.g. custom
              // folders, or any folder_type not covered by the locale files) —
              // otherwise the raw key like "empty.custom" leaks into the UI.
              const emptyKey = activeFilter === "starred"
                ? "starred"
                : showAllInboxes
                ? "inbox"
                : currentFolder?.folder_type || activeCombinedFolder || "default";
              return (
                <EmptyState
                  icon={getEmptyIcon(currentFolder?.folder_type, activeCombinedFolder, activeFilter, showAllInboxes)}
                  title={t([`empty.${emptyKey}`, "empty.default"])}
                  description={t([`emptyDesc.${emptyKey}`, "emptyDesc.default"])}
                />
              );
            })()
          ) : (
            <VirtualMailList
              listRef={listRef}
              filteredMails={filteredMails}
              selectedMailIndex={selectedMailIndex}
              selectedMailId={selectedMailId}
              selectedMailIds={selectedMailIds}
              multiSelectMode={multiSelectMode}
              appSettings={appSettings}
              dateGroupLabels={dateGroupLabels}
              snoozeMenuId={snoozeMenuId}
              setSnoozeMenuId={setSnoozeMenuId}
              hasNextPage={hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              handleListScroll={handleListScroll}
              handleMailClick={handleMailClick}
              handleContextMenu={handleContextMenu}
              handleDragStart={handleDragStart}
              handleDrag={handleDrag}
              handleDragEnd={handleDragEnd}
              setMailItemRef={setMailItemRef}
              setMails={setMails}
              toggleMailSelection={toggleMailSelection}
              toggleStarMutation={toggleStarMutation}
              setPendingRemoveId={setPendingRemoveId}
              invalidateMailQueries={invalidateMailQueries}
              archiveMail={archiveMail}
              trashMail={trashMail}
              snoozeMail={snoozeMail}
              onArchiveSuccess={handleArchiveSuccess}
              t={t}
            />
          )}
        </LoadingCrossfade>
      )}

      <DragPreview mail={draggingMail} position={dragPosition} grabOffset={grabOffset} width={dragItemWidth} />

      {contextMenu && (
        <MailContextMenu
          mail={contextMenu.mail}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onReply={(m) => openCompose("reply", m)}
          onReplyAll={(m) => openCompose("replyAll", m)}
          onForward={(m) => openCompose("forward", m)}
          onToggleStar={(m) => {
            const prev = m.is_starred;
            setMails((prev_) => prev_.map((ml) => ml.id === m.id ? { ...ml, is_starred: !prev } : ml));
            toggleStarMutation.mutate(m.id, {
              onError: () => setMails((prev_) => prev_.map((ml) => ml.id === m.id ? { ...ml, is_starred: prev } : ml)),
            });
          }}
          onToggleRead={(m) => {
            const prev = m.is_read;
            setMails((prev_) => prev_.map((ml) => ml.id === m.id ? { ...ml, is_read: !prev } : ml));
            toggleRead(m.id).then(() => invalidateMailQueries()).catch(() => {
              setMails((prev_) => prev_.map((ml) => ml.id === m.id ? { ...ml, is_read: prev } : ml));
            });
          }}
          onArchive={(m) => {
            setPendingRemoveId(m.id);
            runMailAction(() => archiveMail(m.id), {
              errorKey: "errors.archive",
              invalidate: invalidateMailQueries,
              onPendingClear: () => setPendingRemoveId(null),
            });
          }}
          onTrash={(m) => {
            setPendingRemoveId(m.id);
            runMailAction(() => trashMail(m.id), {
              errorKey: "errors.trash",
              invalidate: invalidateMailQueries,
              onPendingClear: () => setPendingRemoveId(null),
            });
          }}
          onTogglePin={(m) => {
            const prev = m.is_pinned;
            setMails((prev_) => prev_.map((ml) => ml.id === m.id ? { ...ml, is_pinned: !prev } : ml));
            togglePinMutation.mutate(m.id, {
              onError: () => setMails((prev_) => prev_.map((ml) => ml.id === m.id ? { ...ml, is_pinned: prev } : ml)),
            });
          }}
          onSnooze={(m, until) => {
            setPendingRemoveId(m.id);
            runMailAction(() => snoozeMail(m.id, until), {
              errorKey: "errors.snooze",
              invalidate: invalidateMailQueries,
              onPendingClear: () => setPendingRemoveId(null),
            });
          }}
        />
      )}
    </div>
  );
}
