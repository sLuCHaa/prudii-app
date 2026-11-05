import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Ellipsis } from "../icons";
import { Tooltip } from "../ui/Tooltip";
import { splitSignature } from "../../lib/signatureFold";

interface SignatureFoldProps {
  html: string;
  render: (html: string, main: boolean) => React.ReactNode;
}

export function SignatureFold({ html, render }: SignatureFoldProps) {
  const { t } = useTranslation();
  const split = useMemo(() => splitSignature(html), [html]);
  const [open, setOpen] = useState(false);
  if (!split) return <>{render(html, true)}</>;

  const label = open ? t("mailDetail.hideSignature") : t("mailDetail.showSignature");
  return (
    <>
      {render(split.body, true)}
      <Tooltip label={label}>
        <button
          type="button"
          aria-expanded={open}
          aria-label={label}
          onClick={() => setOpen(!open)}
          className="mt-1 mb-1 inline-flex items-center px-2 py-0.5 rounded-sm border border-border text-text-tertiary hover:bg-hover hover:text-text-secondary transition-colors"
        >
          <Ellipsis className="w-3.5 h-3.5" />
        </button>
      </Tooltip>
      <div className={`reveal-y ${open ? "reveal-open" : ""}`}>
        <div inert={!open}>{render(split.signature, false)}</div>
      </div>
    </>
  );
}
