import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Pencil } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Tooltip } from "../ui/Tooltip";
import { ContextMenu } from "../ui/ContextMenu";
import { useAppStore } from "../../stores/appStore";
import type { MailAddress } from "../../types";

interface AddressNameProps {
  address: MailAddress;
  children?: ReactNode;
  className?: string;
}

/** A person in the thread: hover shows the real address, right-click writes to it or copies it. */
export function AddressName({ address, children, className }: AddressNameProps) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const label = children ?? (address.name || address.email);
  const showsAddress = typeof label === "string" && label.includes(address.email);

  const span = (
    <span
      className={className}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {label}
    </span>
  );

  return (
    <>
      {showsAddress ? span : <Tooltip label={address.email} className="min-w-0">{span}</Tooltip>}
      {menu && (
        // The menu is portalled, but React still bubbles its clicks and keys to the
        // header around this name, which would toggle the message.
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <ContextMenu
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            ariaLabel={address.email}
            entries={[
              {
                kind: "item",
                id: "compose",
                label: t("mailDetail.newMailTo", { name: address.name || address.email }),
                icon: <Pencil className="w-4 h-4" />,
                onSelect: () => useAppStore.getState().openMailto(`mailto:${encodeURIComponent(address.email)}`),
              },
              {
                kind: "item",
                id: "copy",
                label: t("mailDetail.copyEmail"),
                icon: <Copy className="w-4 h-4" />,
                onSelect: () => { void writeText(address.email); },
              },
            ]}
          />
        </span>
      )}
    </>
  );
}
