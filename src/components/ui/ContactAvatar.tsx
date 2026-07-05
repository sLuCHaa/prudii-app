// Backwards-compatible wrapper. New code should import GradientAvatar directly.

import { GradientAvatar } from "../motion/GradientAvatar";

interface ContactAvatarProps {
  name: string;
  email: string;
  size?: number;
  className?: string;
}

export function ContactAvatar({ name, email, size = 32, className = "" }: ContactAvatarProps) {
  return <GradientAvatar email={email} name={name} size={size} className={className} />;
}
