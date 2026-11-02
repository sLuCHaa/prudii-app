export interface AnimatedIconProps {
  size?: number | string;
  color?: string;
  className?: string;
}

export interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}
