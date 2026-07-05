import { Apple, Mail, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PROVIDER_PRESETS, type ProviderPreset } from "../../lib/providers";
import { SpringCard } from "../motion/SpringCard";

interface ProviderSelectProps {
  onSelect: (provider: ProviderPreset) => void;
}

function ProviderIcon({ id }: { id: string }) {
  if (id === "custom") return <Settings className="w-6 h-6" />;
  if (id === "apple") return <Apple className="w-6 h-6" />;
  return <Mail className="w-6 h-6" />;
}

export function ProviderSelect({ onSelect }: ProviderSelectProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold text-text">{t("wizard.chooseProvider")}</h3>
      <p className="text-sm text-text-tertiary">
        {t("wizard.chooseProviderDesc")}
      </p>
      <div className="grid grid-cols-1 gap-2 mt-4">
        {PROVIDER_PRESETS.map((provider) => (
          <SpringCard
            key={provider.id}
            glow
            lift={6}
            className="p-3 flex items-center gap-3"
            onClick={() => onSelect(provider)}
          >
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center text-white shrink-0"
              style={{ backgroundColor: provider.color }}
            >
              <ProviderIcon id={provider.id} />
            </div>
            <div>
              <div className="font-medium text-text">{provider.name}</div>
              <div className="text-xs text-text-tertiary">
                {provider.id !== "custom" ? provider.imapHost : t("wizard.configureManually")}
              </div>
            </div>
          </SpringCard>
        ))}
      </div>
    </div>
  );
}
