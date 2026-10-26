import { describe, it, expect } from "vitest";
import { viewKind, viewableOfKind } from "./attachmentView";

describe("viewKind", () => {
  it("shows images the webview can render in the lightbox", () => {
    expect(viewKind("image/png", "scan.png")).toBe("image");
    expect(viewKind("IMAGE/JPEG", "foto.jpg")).toBe("image");
    expect(viewKind("image/svg+xml", "logo.svg")).toBe("image");
  });

  it("hands images the webview cannot render to the system", () => {
    expect(viewKind("image/heic", "IMG_0042.heic")).toBe("file");
    expect(viewKind("image/tiff", "plan.tiff")).toBe("file");
  });

  it("recognises PDFs by type or by name", () => {
    expect(viewKind("application/pdf", "angebot.pdf")).toBe("pdf");
    expect(viewKind("application/octet-stream", "Rechnung.PDF")).toBe("pdf");
  });

  it("opens everything else as a file", () => {
    expect(viewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "brief.docx")).toBe("file");
    expect(viewKind("", "notizen")).toBe("file");
  });
});

describe("viewableOfKind", () => {
  const att = (id: string, type: string, name: string, status: "loading" | "ready" | "failed" = "ready") => ({ id, type, name, status });

  it("keeps the ready attachments of one kind in their order", () => {
    const list = [
      att("a", "image/png", "eins.png"),
      att("b", "application/pdf", "zwei.pdf"),
      att("c", "image/jpeg", "drei.jpg", "loading"),
      att("d", "image/gif", "vier.gif"),
      att("e", "image/webp", "fuenf.webp", "failed"),
    ];
    expect(viewableOfKind(list, "image").map((a) => a.id)).toEqual(["a", "d"]);
    expect(viewableOfKind(list, "pdf").map((a) => a.id)).toEqual(["b"]);
  });
});
