import { openUrl } from "@tauri-apps/plugin-opener";
import { linkify } from "../../lib/calendar/meetingLinks";

export function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.text}</span>
        ) : (
          <a
            key={i}
            href={part.href}
            onClick={(e) => {
              e.preventDefault();
              openUrl(part.href).catch(() => {});
            }}
            className="text-accent hover:underline break-all"
          >
            {part.text}
          </a>
        ),
      )}
    </>
  );
}
