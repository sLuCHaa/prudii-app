import { Copy, ExternalLink, Image as ImageIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ContextMenu } from "../ui/ContextMenu";
import type { BridgeContextMenu } from "../../lib/mailLinkBridge";
import type { MenuEntry } from "../../lib/menuModel";

interface Props {
  target: BridgeContextMenu;
  x: number;
  y: number;
  onClose: () => void;
  onOpenLink: (href: string) => void;
  onOpenImage?: (src: string) => void;
}

export function MailBodyContextMenu({ target, x, y, onClose, onOpenLink, onOpenImage }: Props) {
  const { t } = useTranslation();
  const entries: MenuEntry[] = [];
  if (target.href) {
    entries.push(
      { kind: "item", id: "openLink", label: t("mailDetail.bodyMenu.openLink"), icon: <ExternalLink className="w-4 h-4" />, onSelect: () => onOpenLink(target.href!) },
      { kind: "item", id: "copyLink", label: t("mailDetail.bodyMenu.copyLink"), icon: <Copy className="w-4 h-4" />, onSelect: () => { writeText(target.href!).catch(() => {}); } },
    );
  }
  if (target.src) {
    if (entries.length) entries.push({ kind: "separator" });
    entries.push(
      ...(onOpenImage ? [{ kind: "item" as const, id: "openImage", label: t("mailDetail.bodyMenu.openImage"), icon: <ImageIcon className="w-4 h-4" />, onSelect: () => onOpenImage(target.src!) }] : []),
      { kind: "item", id: "copyImageUrl", label: t("mailDetail.bodyMenu.copyImageAddress"), icon: <Copy className="w-4 h-4" />, onSelect: () => { writeText(target.src!).catch(() => {}); } },
    );
  }
  if (target.selection) {
    if (entries.length) entries.push({ kind: "separator" });
    entries.push({ kind: "item", id: "copy", label: t("mailDetail.bodyMenu.copy"), icon: <Copy className="w-4 h-4" />, onSelect: () => { writeText(target.selection!).catch(() => {}); } });
  }
  if (entries.length === 0) return null;
  return <ContextMenu entries={entries} x={x} y={y} onClose={onClose} />;
}
