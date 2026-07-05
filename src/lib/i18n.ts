import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import de from "../locales/de.json";
import en from "../locales/en.json";
import es from "../locales/es.json";
import zh from "../locales/zh.json";
import fr from "../locales/fr.json";
import pt from "../locales/pt.json";
import ru from "../locales/ru.json";

const STORAGE_KEY = "prudii-language";

export type AppLanguage = "de" | "en" | "es" | "zh" | "fr" | "pt" | "ru" | "system";

const SUPPORTED_LANGS = ["de", "en", "es", "zh", "fr", "pt", "ru"] as const;

function getInitialLanguage(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && stored !== "system") return stored;

  const nav = navigator.language || "";
  const prefix = nav.split("-")[0].toLowerCase();
  if ((SUPPORTED_LANGS as readonly string[]).includes(prefix)) return prefix;
  return "en";
}

i18n.use(initReactI18next).init({
  resources: {
    de: { translation: de },
    en: { translation: en },
    es: { translation: es },
    zh: { translation: zh },
    fr: { translation: fr },
    pt: { translation: pt },
    ru: { translation: ru },
  },
  lng: getInitialLanguage(),
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

/**
 * Change language and persist to localStorage.
 * Pass "system" to auto-detect from OS.
 */
export function changeLanguage(lang: AppLanguage) {
  localStorage.setItem(STORAGE_KEY, lang);
  if (lang === "system") {
    const nav = navigator.language || "";
    const prefix = nav.split("-")[0].toLowerCase();
    const resolved = (SUPPORTED_LANGS as readonly string[]).includes(prefix) ? prefix : "en";
    i18n.changeLanguage(resolved);
  } else {
    i18n.changeLanguage(lang);
  }
}

/** Get the currently persisted language preference (may be "system"). */
export function getLanguagePreference(): AppLanguage {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && (SUPPORTED_LANGS as readonly string[]).includes(stored)) return stored as AppLanguage;
  if (stored === "system") return "system";
  return "system";
}

export default i18n;
