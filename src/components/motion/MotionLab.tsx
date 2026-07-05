// DEV-only visual lab for the motion primitives. Mounted via Ctrl+Shift+M
// in development builds; stripped from production via import.meta.env.DEV.
//
// Add each new primitive here as you build it so you can see it in isolation
// without navigating to its real surface.

import { useState } from "react";
import { CelebrationConfetti } from "./CelebrationConfetti";
import { GlowRing } from "./GlowRing";
import { GradientAvatar } from "./GradientAvatar";
import { HoverLift } from "./HoverLift";
import { NumberTween } from "./NumberTween";
import { PulseDot } from "./PulseDot";
import { SpringCard } from "./SpringCard";
import { StackedToast, type StackedToastItem } from "./StackedToast";

type Section = {
  id: string;
  label: string;
  render: () => React.ReactNode;
};

function NumberTweenDemo() {
  const [target, setTarget] = useState(2847);
  return (
    <div className="space-y-6">
      <h3 className="font-semibold">NumberTween — count-up</h3>
      <div className="text-6xl font-bold font-heading">
        <NumberTween from={0} to={target} />
      </div>
      <div className="flex gap-2">
        {[0, 42, 142, 2847, 99999].map((v) => (
          <button
            key={v}
            onClick={() => setTarget(v)}
            className="px-3 py-1.5 text-sm rounded-lg bg-hover hover:bg-active transition-colors"
          >
            tween to {v.toLocaleString()}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConfettiDemo() {
  const [t, setT] = useState(0);
  return (
    <div className="space-y-6">
      <h3 className="font-semibold">CelebrationConfetti — click to burst</h3>
      <div className="relative w-64 h-64 rounded-2xl bg-surface border border-border flex items-center justify-center">
        <button
          onClick={() => setT((v) => v + 1)}
          className="px-4 py-2 rounded-lg bg-accent text-text-inverse font-semibold relative z-10"
        >
          Celebrate!
        </button>
        <CelebrationConfetti trigger={t} count={40} />
      </div>
    </div>
  );
}

function StackedToastDemo() {
  const [items, setItems] = useState<StackedToastItem[]>([]);
  function add(variant: "info" | "success" | "warning" | "error" | "undo") {
    const id = String(Date.now()) + Math.random();
    const item: StackedToastItem = {
      id,
      variant,
      dismissible: true,
      onDismiss: () => setItems((cur) => cur.filter((x) => x.id !== id)),
      render: () => (
        <div className="px-4 py-3 text-sm">
          <div className="font-semibold capitalize">{variant} toast</div>
          <div className="text-xs text-text-secondary">Swipe right to dismiss</div>
        </div>
      ),
    };
    setItems((cur) => [...cur, item]);
  }
  return (
    <div className="space-y-4">
      <h3 className="font-semibold">StackedToast — click to add</h3>
      <div className="flex gap-2 flex-wrap">
        {(["info", "success", "warning", "error", "undo"] as const).map((v) => (
          <button
            key={v}
            onClick={() => add(v)}
            className="px-3 py-1.5 text-sm rounded-lg bg-hover hover:bg-active transition-colors capitalize"
          >
            + {v}
          </button>
        ))}
      </div>
      <StackedToast toasts={items} />
    </div>
  );
}

const SECTIONS: Section[] = [
  {
    id: "hover-lift",
    label: "HoverLift",
    render: () => (
      <div className="space-y-6">
        <h3 className="font-semibold">HoverLift — hover the cards</h3>
        <div className="flex gap-4">
          {([1, 2, 3] as const).map((i) => (
            <HoverLift key={i} intensity={i} className="cursor-pointer">
              <div className="w-40 h-28 rounded-xl bg-surface border border-border p-4">
                <div className="text-xs text-text-tertiary">intensity</div>
                <div className="text-2xl font-bold">{i}</div>
              </div>
            </HoverLift>
          ))}
        </div>
      </div>
    ),
  },
  {
    id: "spring-card",
    label: "SpringCard",
    render: () => (
      <div className="space-y-6">
        <h3 className="font-semibold">SpringCard — with optional glow</h3>
        <div className="flex gap-4">
          <SpringCard className="w-48 p-4">
            <div className="text-xs text-text-tertiary">basic</div>
            <div className="text-base font-semibold">Default card</div>
          </SpringCard>
          <SpringCard className="w-48 p-4" glow>
            <div className="text-xs text-text-tertiary">glow</div>
            <div className="text-base font-semibold">With accent glow</div>
          </SpringCard>
          <SpringCard className="w-48 p-4" lift={8} glow selected>
            <div className="text-xs text-text-tertiary">selected</div>
            <div className="text-base font-semibold">Selected + lift 8</div>
          </SpringCard>
        </div>
      </div>
    ),
  },
  {
    id: "pulse-dot",
    label: "PulseDot",
    render: () => (
      <div className="space-y-6">
        <h3 className="font-semibold">PulseDot — live status</h3>
        <div className="flex items-center gap-12">
          <div className="flex flex-col items-center gap-2">
            <PulseDot />
            <div className="text-xs text-text-tertiary">accent · default</div>
          </div>
          <div className="flex flex-col items-center gap-2">
            <PulseDot color="var(--c-success)" size={10} ringCount={3} />
            <div className="text-xs text-text-tertiary">success · 3 rings</div>
          </div>
          <div className="flex flex-col items-center gap-2">
            <PulseDot color="var(--c-danger)" size={6} />
            <div className="text-xs text-text-tertiary">danger · small</div>
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "glow-ring",
    label: "GlowRing",
    render: () => (
      <div className="space-y-8">
        <div>
          <h3 className="font-semibold mb-3">GlowRing — wrapper mode</h3>
          <div className="flex gap-4 items-center">
            {([1, 2, 3] as const).map((i) => (
              <GlowRing key={i} intensity={i}>
                <div className="w-32 h-20 rounded-xl bg-surface border border-border p-3 text-xs">
                  intensity {i}
                </div>
              </GlowRing>
            ))}
          </div>
        </div>
        <div>
          <h3 className="font-semibold mb-3">GlowRing — progress arc (0.7)</h3>
          <GlowRing progress={0.7} size={44} strokeWidth={4}>
            <span className="text-xs font-bold text-accent">70%</span>
          </GlowRing>
        </div>
      </div>
    ),
  },
  {
    id: "gradient-avatar",
    label: "GradientAvatar",
    render: () => (
      <div className="space-y-6">
        <h3 className="font-semibold">GradientAvatar — deterministic per email</h3>
        <div className="flex items-center gap-6 flex-wrap">
          {["anna@studio.de", "max@example.com", "support@bank.com", "no-reply@github.com", "team@figma.com"].map(
            (e) => (
              <div key={e} className="flex flex-col items-center gap-2">
                <GradientAvatar email={e} name={e.split("@")[0]} size={48} />
                <div className="text-[10px] text-text-tertiary">{e}</div>
              </div>
            ),
          )}
        </div>
        <div className="flex items-center gap-6 mt-8">
          <GradientAvatar email="hero@prudii.com" name="Prudii Team" size={80} ring />
          <div className="text-sm">size=80, ring=true</div>
        </div>
      </div>
    ),
  },
  {
    id: "number-tween",
    label: "NumberTween",
    render: () => <NumberTweenDemo />,
  },
  {
    id: "confetti",
    label: "CelebrationConfetti",
    render: () => <ConfettiDemo />,
  },
  {
    id: "stacked-toast",
    label: "StackedToast",
    render: () => <StackedToastDemo />,
  },
];

export function MotionLab({ onClose }: { onClose: () => void }) {
  const [activeId, setActiveId] = useState(SECTIONS[0]?.id ?? "");
  const active = SECTIONS.find((s) => s.id === activeId);

  return (
    <div className="fixed inset-0 z-200 bg-bg text-text flex">
      <aside className="w-56 border-r border-border p-3 overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Motion Lab</h2>
          <button onClick={onClose} className="text-xs text-text-tertiary hover:text-text">
            ✕
          </button>
        </div>
        <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-2">
          Primitives
        </div>
        <nav className="flex flex-col gap-1">
          {SECTIONS.length === 0 && (
            <div className="text-xs text-text-tertiary italic">No primitives yet</div>
          )}
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveId(s.id)}
              className={`text-left text-sm px-2 py-1.5 rounded transition-colors ${
                activeId === s.id ? "bg-selected text-text" : "hover:bg-hover text-text-secondary"
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto p-8">
        {active ? active.render() : <div className="text-text-tertiary">Select a primitive</div>}
      </main>
    </div>
  );
}
