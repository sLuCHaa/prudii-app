import { ProviderSelect } from "./ProviderSelect";
import type { ProviderPreset } from "../../lib/providers";

interface WizardStepProviderProps {
  onSelect: (provider: ProviderPreset) => void;
}

export function WizardStepProvider({ onSelect }: WizardStepProviderProps) {
  return <ProviderSelect onSelect={onSelect} />;
}
