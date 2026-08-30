import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../locales/en.json";

const STORAGE_KEY = "prudii-language";

export type AppLanguage = "de" | "en" | "es" | "zh" | "fr" | "pt" | "ru" | "system";

const SUPPORTED_LANGS = ["de", "en", "es", "zh", "fr", "pt", "ru"] as const;

// Only English ships in the entry chunk; the other six locales (~270 KB of
// JSON) load on demand — the user needs exactly one of them, and parsing all
// seven up front delayed every cold start.
const LOCALE_LOADERS: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  de: () => import("../locales/de.json"),
  es: () => import("../locales/es.json"),
  zh: () => import("../locales/zh.json"),
  fr: () => import("../locales/fr.json"),
  pt: () => import("../locales/pt.json"),
  ru: () => import("../locales/ru.json"),
};

async function ensureLanguageLoaded(lang: string): Promise<void> {
  if (lang === "en" || i18n.hasResourceBundle(lang, "translation")) return;
  const loader = LOCALE_LOADERS[lang];
  if (!loader) return;
  const mod = await loader();
  i18n.addResourceBundle(lang, "translation", mod.default, true, true);
}

function resolveSystemLanguage(): string {
  const nav = navigator.language || "";
  const prefix = nav.split("-")[0].toLowerCase();
  return (SUPPORTED_LANGS as readonly string[]).includes(prefix) ? prefix : "en";
}

function getInitialLanguage(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && stored !== "system") return stored;
  return resolveSystemLanguage();
}

const initialLanguage = getInitialLanguage();

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  // Start on English until the real bundle is in — the local chunk resolves
  // within the splash, so the swap happens before the UI is visible.
  lng: "en",
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

if (initialLanguage !== "en") {
  ensureLanguageLoaded(initialLanguage).then(() => {
    i18n.changeLanguage(initialLanguage);
  });
}

// Keep the document language in sync — screen readers and font fallback
// pick their rules from <html lang>, which index.html hardcodes to "en".
document.documentElement.lang = i18n.language;
i18n.on("languageChanged", (lang) => {
  document.documentElement.lang = lang;
});

/**
 * Change language and persist to localStorage.
 * Pass "system" to auto-detect from OS.
 */
export function changeLanguage(lang: AppLanguage) {
  localStorage.setItem(STORAGE_KEY, lang);
  const resolved = lang === "system" ? resolveSystemLanguage() : lang;
  ensureLanguageLoaded(resolved).then(() => {
    i18n.changeLanguage(resolved);
  });
}

/** Get the currently persisted language preference (may be "system"). */
export function getLanguagePreference(): AppLanguage {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && (SUPPORTED_LANGS as readonly string[]).includes(stored)) return stored as AppLanguage;
  if (stored === "system") return "system";
  return "system";
}

export default i18n;
