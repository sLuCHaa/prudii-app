import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { listSignatures } from "../lib/tauri";
import { sortSignatures } from "../lib/signatures";
import type { Signature } from "../types";

/** The signature list in the order it is shown. */
export function useSignatures() {
  const { i18n } = useTranslation();
  const select = useCallback((list: Signature[]) => sortSignatures(list, i18n.language), [i18n.language]);
  return useQuery({ queryKey: ["signatures"], queryFn: listSignatures, select });
}
