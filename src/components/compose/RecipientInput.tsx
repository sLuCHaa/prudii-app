import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X } from "lucide-react";
import { searchContacts } from "../../lib/tauri";
import type { Contact } from "../../types";
import { SPRING_BOUNCY } from "../motion/tokens";
import { GradientAvatar } from "../motion/GradientAvatar";

interface RecipientInputProps {
  recipients: string[];
  onChange: (recipients: string[]) => void;
  placeholder?: string;
  accountId?: string;
  autoFocus?: boolean;
  fieldId?: "to" | "cc" | "bcc";
  onChipDroppedFromField?: (sourceField: "to" | "cc" | "bcc", recipient: string) => void;
  blockedEmails?: string[];
}

export interface RecipientInputHandle {
  commitPending: () => string | null;
}

const DND_TYPE = "application/x-prudii-recipient";

export const RecipientInput = forwardRef<RecipientInputHandle, RecipientInputProps>(function RecipientInput({
  recipients,
  onChange,
  placeholder,
  accountId,
  autoFocus,
  fieldId,
  onChipDroppedFromField,
  blockedEmails = [],
}: RecipientInputProps, ref) {
  const emailOf = (raw: string) => {
    const m = raw.match(/<([^>]+)>/);
    return (m ? m[1] : raw).trim().toLowerCase();
  };

  const [inputValue, setInputValue] = useState("");
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [draggingRecipient, setDraggingRecipient] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const commitValue = useCallback(
    (raw: string) => {
      const trimmed = raw.trim().replace(/,+$/, "").trim();
      if (!trimmed) return;
      // Avoid duplicates (case-insensitive) and cross-field blocked addresses
      const email = emailOf(trimmed);
      const already = recipients.some((r) => emailOf(r) === email) || blockedEmails.includes(email);
      if (!already) {
        onChange([...recipients, trimmed]);
      }
      setInputValue("");
      setSuggestions([]);
      setShowDropdown(false);
    },
    [recipients, onChange, blockedEmails],
  );

  useImperativeHandle(ref, () => ({
    commitPending: () => {
      const trimmed = inputValue.trim();
      if (!trimmed) return null;
      const normalized = trimmed.replace(/,+$/, "").trim();
      commitValue(inputValue); // dedupes against recipients/blockedEmails + clears the input
      if (!normalized) return null;
      const email = emailOf(normalized);
      const isDup = recipients.some((r) => emailOf(r) === email) || blockedEmails.includes(email);
      return isDup ? null : normalized;
    },
  }), [inputValue, commitValue, recipients, blockedEmails]);

  const doSearch = useCallback(
    (query: string) => {
      if (query.length < 2) {
        setSuggestions([]);
        setShowDropdown(false);
        return;
      }

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(async () => {
        try {
          const results = await searchContacts(query, accountId);
          setSuggestions(results);
          setShowDropdown(results.length > 0);
          setSelectedIndex(0);
        } catch {
          setSuggestions([]);
          setShowDropdown(false);
        }
      }, 200);
    },
    [accountId],
  );

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    // Commit completed addresses on a delimiter (comma, semicolon or newline) —
    // also handles pasting several addresses at once. Space is intentionally not a
    // delimiter so a "Name <email>" display name stays intact.
    if (/[,;\n]/.test(val)) {
      const parts = val.split(/[,;\n]/);
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i].trim();
        if (part) commitValue(part);
      }
      setInputValue(parts[parts.length - 1]);
      return;
    }
    setInputValue(val);
    doSearch(val.trim());
  }

  function selectSuggestion(contact: Contact) {
    const hasRealName = contact.name && contact.name !== contact.email && !contact.name.includes("@");
    const formatted = hasRealName
      ? `${contact.name} <${contact.email}>`
      : contact.email;
    const already = recipients.some((r) => emailOf(r) === emailOf(formatted)) || blockedEmails.includes(emailOf(formatted));
    if (!already) {
      onChange([...recipients, formatted]);
    }
    setInputValue("");
    setSuggestions([]);
    setShowDropdown(false);
    inputRef.current?.focus();
  }

  function removeRecipient(index: number) {
    onChange(recipients.filter((_, i) => i !== index));
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (showDropdown && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectSuggestion(suggestions[selectedIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        setShowDropdown(false);
        return;
      }
    }

    if (e.key === "Enter" || e.key === "Tab") {
      if (inputValue.trim()) {
        e.preventDefault();
        commitValue(inputValue);
        return;
      }
    }

    if (e.key === "Backspace" && !inputValue && recipients.length > 0) {
      onChange(recipients.slice(0, -1));
    }
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
        if (inputValue.trim()) {
          commitValue(inputValue);
        }
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [inputValue, commitValue]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  // Fallback: chip may unmount mid-drag after a successful drop into another field,
  // so its own onDragEnd never fires. Listen at the window level too.
  useEffect(() => {
    function onDragEnd() { setDraggingRecipient(null); }
    window.addEventListener("dragend", onDragEnd);
    return () => window.removeEventListener("dragend", onDragEnd);
  }, []);

  useEffect(() => {
    if (autoFocus) {
      // Small delay to ensure DOM is ready (modal animation)
      const timer = setTimeout(() => inputRef.current?.focus(), 80);
      return () => clearTimeout(timer);
    }
  }, [autoFocus]);

  const isLikelyValid = (raw: string) => {
    const m = raw.match(/<([^>]+)>/);
    const email = (m ? m[1] : raw).trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  return (
    <div className="relative flex-1" ref={containerRef}>
      <div
        className={`flex flex-wrap items-center gap-1 min-h-[36px] py-1 cursor-text rounded-md transition-shadow ${
          dragOver ? "ring-2 ring-accent" : ""
        }`}
        onClick={() => inputRef.current?.focus()}
        onDragOver={(e) => {
          if (!fieldId || !onChipDroppedFromField) return;
          if (!e.dataTransfer.types.includes(DND_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!containerRef.current) return;
          if (!containerRef.current.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={(e) => {
          setDragOver(false);
          if (!fieldId || !onChipDroppedFromField) return;
          const raw = e.dataTransfer.getData(DND_TYPE);
          if (!raw) return;
          e.preventDefault();
          try {
            const payload = JSON.parse(raw) as { sourceField: "to" | "cc" | "bcc"; recipient: string };
            if (payload.sourceField === fieldId) return;
            onChipDroppedFromField(payload.sourceField, payload.recipient);
          } catch { /* malformed payload, ignore */ }
        }}
      >
        <AnimatePresence initial={false}>
          {recipients.map((recipient, i) => {
            const match = recipient.match(/^(.+?)\s*<(.+?)>$/);
            const display = match ? match[1].trim() : recipient;
            const email = match ? match[2] : recipient;

            return (
              <motion.span
                key={recipient}
                layout
                initial={{ opacity: 0, scale: 0.6, y: -4 }}
                animate={{
                  opacity: draggingRecipient === recipient ? 0.4 : 1,
                  scale: 1,
                  y: 0,
                }}
                exit={{ opacity: 0, scale: 0.7, transition: { duration: 0.15 } }}
                transition={SPRING_BOUNCY}
                draggable={!!fieldId}
                onDragStart={(e) => {
                  if (!fieldId) return;
                  const de = e as unknown as React.DragEvent<HTMLSpanElement>;
                  de.dataTransfer.setData(
                    DND_TYPE,
                    JSON.stringify({ sourceField: fieldId, recipient }),
                  );
                  de.dataTransfer.effectAllowed = "move";
                  setDraggingRecipient(recipient);
                }}
                onDragEnd={() => setDraggingRecipient(null)}
                className={`inline-flex items-center gap-1 max-w-[240px] px-2 py-0.5 rounded-md bg-accent/15 text-accent text-xs font-medium group ${fieldId ? "cursor-grab" : ""}${isLikelyValid(recipient) ? "" : " ring-1 ring-danger/50 text-danger"}`}
                title={isLikelyValid(recipient) ? (match ? `${display} <${email}>` : email) : "Invalid email address"}
              >
                <GradientAvatar email={email} name={display} size={18} />
                <span className="truncate">{display}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRecipient(i);
                  }}
                  className="shrink-0 p-0.5 rounded-sm hover:bg-accent/30 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </motion.span>
            );
          })}
        </AnimatePresence>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (inputValue.trim().length >= 2 && suggestions.length > 0) {
              setShowDropdown(true);
            }
          }}
          placeholder={recipients.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[120px] bg-transparent text-sm text-text placeholder:text-text-secondary"
        />
      </div>

      {showDropdown && suggestions.length > 0 && (
        <div className="absolute left-0 top-full mt-1 w-full bg-surface border border-border rounded-lg shadow-lg py-1 z-50 max-h-[240px] overflow-y-auto">
          {suggestions.map((contact, i) => (
            <button
              key={contact.email}
              onMouseDown={(e) => {
                e.preventDefault();
                selectSuggestion(contact);
              }}
              onMouseEnter={() => setSelectedIndex(i)}
              className={`flex items-center gap-2 w-full px-3 py-2 text-left transition-colors ${
                i === selectedIndex ? "bg-hover" : "hover:bg-hover"
              }`}
            >
              <div className="w-7 h-7 rounded-full bg-accent/20 text-accent flex items-center justify-center text-xs font-semibold shrink-0">
                {(contact.name || contact.email).charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                {contact.name && (
                  <div className="text-sm text-text truncate">
                    {contact.name}
                  </div>
                )}
                <div className="text-xs text-text-secondary truncate">
                  {contact.email}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
