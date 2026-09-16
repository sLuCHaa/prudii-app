// Prudiis eigenes Hero-Set: die 16 Icons, die in jedem Screenshot vorkommen.
// Alles andere bleibt lucide-react — 124 eigene Icons zu pflegen zahlt sich
// nicht aus, diese 16 tragen die Wiedererkennung allein.
//
// Bauregel: 24er-Grid, geschlossene Silhouette mit 28 % Füllung plus 1,7 px
// Kontur, Details als Strich darüber. Die Füllung liegt bewusst höher als bei
// klassischem Duotone (18 %) — bei 17 px in der Sidebar zerfallen die Formen
// sonst. Alle Endpunkte sind um die halbe Strichbreite (0,85) eingerückt, damit
// die runden Caps nicht über die Silhouette hinausragen.
//
// Farbe kommt immer über currentColor, Größe über `size` — API wie lucide-react,
// damit der Tausch an der Importzeile endet.

export interface DuotoneIconProps extends Omit<React.SVGProps<SVGSVGElement>, "ref"> {
  size?: number | string;
}

const STROKE = 1.7;
const FILL_OPACITY = 0.28;

function Duotone({
  body,
  cut,
  extra,
  size = 20,
  ...rest
}: DuotoneIconProps & { body?: string; cut?: string; extra?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      {body && (
        <>
          <path d={body} fill="currentColor" fillOpacity={FILL_OPACITY} />
          <path d={body} stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round" />
        </>
      )}
      {cut && (
        <path d={cut} stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      )}
      {extra && (
        <path d={extra} stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

export const Inbox = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M6.6 4.3h10.8a2.4 2.4 0 0 1 2.2 1.5L22 12v5.4a2.6 2.6 0 0 1-2.6 2.6H4.6A2.6 2.6 0 0 1 2 17.4V12l2.4-6.2a2.4 2.4 0 0 1 2.2-1.5z"
    cut="M2.85 12h4.75l1.5 2.6h5.8l1.5-2.6h4.75"
  />
);

export const Send = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M21.6 2.4 2.7 9.5a.6.6 0 0 0 0 1.1l8 3.2 3.2 8a.6.6 0 0 0 1.1 0z"
    cut="M21.1 2.9 10.7 13.3"
  />
);

export const Compose = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M17.1 2.7a2.1 2.1 0 0 1 3 0l1.2 1.2a2.1 2.1 0 0 1 0 3L9.1 18.1l-5.1 1.5 1.5-5.1z"
    cut="M15.4 4.4 19.6 8.6"
  />
);

export const Reply = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M9.6 5.7 2.7 11.5a.7.7 0 0 0 0 1l6.9 5.8a.7.7 0 0 0 1.2-.5V6.2a.7.7 0 0 0-1.2-.5z"
    extra="M10.8 9.6h3.5A6.7 6.7 0 0 1 21 16.3v2.1"
  />
);

export const ReplyAll = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M13.4 5.7 6.5 11.5a.7.7 0 0 0 0 1l6.9 5.8a.7.7 0 0 0 1.2-.5V6.2a.7.7 0 0 0-1.2-.5z"
    extra="M7.4 6.4 2.2 11.5a.7.7 0 0 0 0 1l5.2 5.1M15.6 9.6h1.1A5.3 5.3 0 0 1 22 14.9v2.4"
  />
);

export const Forward = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M14.4 5.7 21.3 11.5a.7.7 0 0 1 0 1l-6.9 5.8a.7.7 0 0 1-1.2-.5V6.2a.7.7 0 0 1 1.2-.5z"
    extra="M13.2 9.6H9.7A6.7 6.7 0 0 0 3 16.3v2.1"
  />
);

export const Archive = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M2.8 4h18.4a1 1 0 0 1 1 1v2.8a1 1 0 0 1-1 1h-.6v8.6a2.6 2.6 0 0 1-2.6 2.6H6a2.6 2.6 0 0 1-2.6-2.6V8.8h-.6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"
    cut="M2.85 8.8h18.3M9.8 12.8h4.4"
  />
);

export const Trash = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M6.2 7.4h11.6l-.9 11.2A2.4 2.4 0 0 1 14.5 21h-5a2.4 2.4 0 0 1-2.4-2.4z"
    cut="M10.2 11.2v5.6M13.8 11.2v5.6"
    extra="M3 6.4h18M9 6.4V4.2a1.6 1.6 0 0 1 1.6-1.6h2.8A1.6 1.6 0 0 1 15 4.2v2.2"
  />
);

export const Star = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M12.5 2.6a.6.6 0 0 0-1 0L8.8 8.2l-6.1.9a.6.6 0 0 0-.3 1l4.4 4.3-1 6.1a.6.6 0 0 0 .8.6l5.4-2.8 5.4 2.8a.6.6 0 0 0 .8-.6l-1-6.1 4.4-4.3a.6.6 0 0 0-.3-1l-6.1-.9z"
  />
);

export const Flag = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M6.2 4h12.6a.7.7 0 0 1 .5 1.2l-3.2 3.6 3.2 3.6a.7.7 0 0 1-.5 1.2H6.2z"
    extra="M5.4 3.4v17.2"
  />
);

export const Attach = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    extra="M20.2 11.6 12 19.8a5.1 5.1 0 0 1-7.2-7.2L13 4.4a3.4 3.4 0 0 1 4.8 4.8l-8.2 8.2a1.7 1.7 0 0 1-2.4-2.4l7.5-7.5"
  />
);

export const Search = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M10.6 3.2a7.4 7.4 0 1 1 0 14.8 7.4 7.4 0 0 1 0-14.8z"
    extra="M16.2 16.2 21.2 21.2"
  />
);

// Wachssiegel statt Standard-Schild: das Motiv, das nur Prudii benutzt.
// Trägt „versiegelt" von selbst und ist die einzige Unterscheidung, wenn der
// Nutzer Grün oder Teal als Akzent wählt und --c-signal farblich kollidiert.
export const Seal = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M12 2.2 14.6 4l3.1-.3 1.2 2.9 2.6 1.8-1 3 1 3-2.6 1.8-1.2 2.9-3.1-.3L12 20.6 9.4 18.8l-3.1.3-1.2-2.9L2.5 14.4l1-3-1-3 2.6-1.8 1.2-2.9L9.4 4z"
    cut="M9.2 11.4 11.4 13.6l3.6-3.8"
  />
);

export const Lock = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M6.4 9.8h11.2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6.4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z"
    cut="M12 14.4v3"
    extra="M8 9.8V7.2a4 4 0 0 1 8 0v2.6"
  />
);

// Noch nirgends verdrahtet: die Konto-Oberflaeche benutzt heute kein
// Personen-Icon. Gehoert zum dokumentierten Hero-Set und wartet darauf.
export const Account = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M12 3a4.3 4.3 0 1 1 0 8.6A4.3 4.3 0 0 1 12 3zM12 13.4c4.4 0 8 2.9 8 6.4a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8c0-3.5 3.6-6.4 8-6.4z"
  />
);

export const Ai = (p: DuotoneIconProps) => (
  <Duotone
    {...p}
    body="M11.4 2.6a.6.6 0 0 1 1.2 0l1.5 5.8a2 2 0 0 0 1.5 1.5l5.8 1.5a.6.6 0 0 1 0 1.2l-5.8 1.5a2 2 0 0 0-1.5 1.5l-1.5 5.8a.6.6 0 0 1-1.2 0l-1.5-5.8a2 2 0 0 0-1.5-1.5l-5.8-1.5a.6.6 0 0 1 0-1.2l5.8-1.5a2 2 0 0 0 1.5-1.5z"
  />
);
