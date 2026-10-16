import { describe, it, expect, vi, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { copySelection } from "./clipboard";

const { writeText } = vi.hoisted(() => ({ writeText: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));

let editor: Editor;

afterEach(() => {
  editor?.destroy();
  writeText.mockClear();
  vi.restoreAllMocks();
});

function make() {
  editor = new Editor({ extensions: [StarterKit], content: "<p>hallo welt</p>" });
  editor.commands.setTextSelection({ from: 7, to: 11 });
  return editor;
}

function browserCopies(result: boolean) {
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => result) });
}

describe("copySelection", () => {
  it("leaves cut and copy to the browser when it can do them", () => {
    browserCopies(true);
    const e = make();
    copySelection(e, true);
    expect(document.execCommand).toHaveBeenCalledWith("cut");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to plain text when the browser refuses to copy", () => {
    browserCopies(false);
    const e = make();
    copySelection(e, false);
    expect(writeText).toHaveBeenCalledWith("welt");
    expect(e.state.doc.textContent).toBe("hallo welt");
  });

  it("removes the text after a fallback cut", () => {
    browserCopies(false);
    const e = make();
    copySelection(e, true);
    expect(writeText).toHaveBeenCalledWith("welt");
    expect(e.state.doc.textContent).toBe("hallo ");
  });
});
