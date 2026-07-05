import { useQuery } from "@tanstack/react-query";
import { getAppConfig } from "../lib/tauri";

export function useAppConfig() {
  return useQuery({
    queryKey: ["app-config"],
    queryFn: getAppConfig,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}
