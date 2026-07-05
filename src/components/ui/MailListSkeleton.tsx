import { Skeleton } from "./Skeleton";

// Five distinct row templates — deterministic, no Math.random
const ROW_TEMPLATES: Array<{
  senderW: string;
  timeW: string;
  subjectW: string;
  snippetW: string;
}> = [
  { senderW: "112px", timeW: "40px",  subjectW: "65%", snippetW: "88%" },
  { senderW: "144px", timeW: "32px",  subjectW: "80%", snippetW: "72%" },
  { senderW: "96px",  timeW: "48px",  subjectW: "55%", snippetW: "93%" },
  { senderW: "128px", timeW: "36px",  subjectW: "75%", snippetW: "60%" },
  { senderW: "80px",  timeW: "44px",  subjectW: "85%", snippetW: "78%" },
];

function MailItemSkeleton({ index }: { index: number }) {
  const tpl = ROW_TEMPLATES[index % ROW_TEMPLATES.length];
  return (
    <div
      className="w-full px-4 py-2 border-b border-border-light"
      style={{ borderLeft: "3px solid transparent" }}
    >
      <div className="flex items-start gap-2.5">
        {/* Unread dot placeholder */}
        <div className="mt-1 shrink-0 w-2 h-2 rounded-full bg-border-light" />

        {/* Avatar */}
        <Skeleton width="28px" height="28px" rounded="full" className="shrink-0" />

        <div className="flex-1 min-w-0 space-y-1.5">
          {/* Row 1: Sender + timestamp */}
          <div className="flex items-center justify-between">
            <Skeleton width={tpl.senderW} height="0.75rem" rounded="sm" />
            <Skeleton width={tpl.timeW} height="0.75rem" rounded="sm" />
          </div>

          {/* Row 2: Subject */}
          <Skeleton width={tpl.subjectW} height="0.75rem" rounded="sm" />

          {/* Row 3: Snippet */}
          <Skeleton width={tpl.snippetW} height="0.75rem" rounded="sm" />
        </div>
      </div>
    </div>
  );
}

export function MailListSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div className="flex-1 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2 border-b border-border">
        <div className="flex items-center justify-between">
          <Skeleton width="150px" height="1.25rem" rounded="md" />
          <Skeleton width="80px" height="2rem" rounded="lg" />
        </div>
      </div>

      <div className="overflow-hidden">
        {Array.from({ length: count }).map((_, i) => (
          <MailItemSkeleton key={i} index={i} />
        ))}
      </div>
    </div>
  );
}
