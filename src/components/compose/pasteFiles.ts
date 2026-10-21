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
            const hasText =
              data.getData("text/html").trim() !== "" || data.getData("text/plain").trim() !== "";
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
