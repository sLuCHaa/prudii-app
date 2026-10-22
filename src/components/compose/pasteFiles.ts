import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

export interface SortedPaste {
  inline: File[];
  attachments: File[];
}

const GENERIC_CLIPBOARD_IMAGE = /^image\.(png|jpe?g|gif|bmp|tiff?)$/i;

export function sortPastedFiles(files: File[]): SortedPaste {
  const inline: File[] = [];
  const attachments: File[] = [];
  for (const f of files) {
    if (f.type.startsWith("image/") && GENERIC_CLIPBOARD_IMAGE.test(f.name)) inline.push(f);
    else attachments.push(f);
  }
  return { inline, attachments };
}

export function displayWidth(pixelWidth: number, devicePixelRatio: number): number {
  return Math.min(640, Math.round(pixelWidth / devicePixelRatio));
}

/** Places items in their original order; one that cannot be placed falls back instead of stopping the rest. */
export async function insertInOrder<T, P>(
  items: T[],
  prepare: (item: T) => Promise<P>,
  place: (item: T, prepared: P) => boolean,
  fallback: (item: T) => void,
): Promise<void> {
  const prepared = items.map((item) => prepare(item).then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  ));
  for (let i = 0; i < items.length; i++) {
    const result = await prepared[i];
    let placed = false;
    try {
      placed = result.ok && place(items[i], result.value);
    } catch {
      placed = false;
    }
    if (!placed) fallback(items[i]);
  }
}

// A browser's "Copy image" adds HTML holding only the <img>; that is no text to keep.
export function clipboardHasText(html: string, plain: string): boolean {
  if (plain.trim() !== "") return true;
  if (html.trim() === "") return false;
  return (new DOMParser().parseFromString(html, "text/html").body.textContent ?? "").trim() !== "";
}

// Office apps put a picture of the selection next to the text; the text must win.
export function shouldTakeOverPaste(sorted: SortedPaste, hasText: boolean): boolean {
  if (sorted.attachments.length > 0) return true;
  return sorted.inline.length > 0 && !hasText;
}

export const FilePaste = Extension.create<{ onPaste: (files: SortedPaste) => void }>({
  name: "filePaste",

  addOptions() {
    return { onPaste: () => {} };
  },

  addProseMirrorPlugins() {
    const { onPaste } = this.options;
    return [
      new Plugin({
        props: {
          handlePaste: (_view, event) => {
            const data = event.clipboardData;
            if (!data || data.files.length === 0) return false;
            const sorted = sortPastedFiles(Array.from(data.files));
            const hasText = clipboardHasText(data.getData("text/html"), data.getData("text/plain"));
            if (!shouldTakeOverPaste(sorted, hasText)) return false;
            event.preventDefault();
            onPaste(sorted);
            return true;
          },
        },
      }),
    ];
  },
});
