// Jeu d'icônes trait fin partagé — remplace les emoji utilisés comme icônes
// fonctionnelles (Nav, Dashboard, boutons d'action). Chaque icône est un
// simple <svg> stroke (24×24, `stroke="currentColor"`, sans remplissage) :
// la couleur suit toujours l'élément parent, jamais fixée en dur ici —
// c'est ce qui permet à un même composant de rendre correctement dans un
// bouton actif (accent), une pastille colorée (Dashboard) ou du texte
// neutre (Nav), sans variante par contexte. Voir CLAUDE.md pour le
// contexte de ce chantier (refonte visuelle, secteurs d'activité).

import type { SVGProps } from "react";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "width" | "height"> {
  size?: number;
}

function Svg({ size = 18, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconDashboard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
  </Svg>
);

export const IconCart = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="20" r="1.3" />
    <circle cx="17" cy="20" r="1.3" />
    <path d="M2.5 3h2.4l1.9 11.2a2 2 0 0 0 2 1.6h8.4a2 2 0 0 0 2-1.6L20.8 7H6" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3.2 2" />
  </Svg>
);

export const IconFileText = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 2.5h8l4 4v14.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" />
    <path d="M14 2.5V7h4" />
    <line x1="8" y1="12" x2="16" y2="12" />
    <line x1="8" y1="16" x2="16" y2="16" />
  </Svg>
);

export const IconTicket = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <path d="M3 10a2 2 0 0 1 0 4" />
    <path d="M21 10a2 2 0 0 0 0 4" />
    <line x1="9" y1="8" x2="9" y2="16" strokeDasharray="1.5 2" />
  </Svg>
);

export const IconPercent = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="2.6" />
    <circle cx="17" cy="17" r="2.6" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </Svg>
);

export const IconBox = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8l9-4.5L21 8l-9 4.5L3 8z" />
    <path d="M3 8v9l9 4.5V12.5" />
    <path d="M21 8v9l-9 4.5" />
  </Svg>
);

export const IconPill = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 17.5a5 5 0 0 1 0-7.07l4.93-4.93a5 5 0 1 1 7.07 7.07l-4.93 4.93a5 5 0 0 1-7.07 0z" />
    <line x1="9.5" y1="14.5" x2="14.5" y2="9.5" />
  </Svg>
);

export const IconUtensils = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.5 2.5v7a1.8 1.8 0 0 0 3.6 0v-7" />
    <line x1="9.3" y1="9.5" x2="9.3" y2="21.5" />
    <path d="M16 2.5c-1.2 2.5-1.2 6 0 7.8s1 3 1 3v8.2" />
  </Svg>
);

export const IconHanger = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3a2 2 0 1 1 2 2v1" />
    <path d="M12 6l-8.3 5.9a1.9 1.9 0 0 0 1.1 3.5h14.4a1.9 1.9 0 0 0 1.1-3.5L12 6z" />
    <line x1="4.2" y1="19" x2="19.8" y2="19" />
  </Svg>
);

export const IconLayers = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 2.5 8 12 13l9.5-5L12 3z" />
    <path d="M2.5 13 12 18l9.5-5" />
  </Svg>
);

export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
    <circle cx="17.5" cy="9" r="2.5" />
    <path d="M15.8 13.6c2.6.2 4.7 2.2 4.7 5.4" />
  </Svg>
);

export const IconTruck = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="7" width="11" height="8" rx="1" />
    <path d="M13.5 10h3.5l3 3v2h-6.5z" />
    <circle cx="7" cy="17.3" r="1.6" />
    <circle cx="17" cy="17.3" r="1.6" />
  </Svg>
);

export const IconBag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 8h12l1 12.3a1.5 1.5 0 0 1-1.5 1.7h-11A1.5 1.5 0 0 1 5 20.3L6 8z" />
    <path d="M8.5 8V6a3.5 3.5 0 0 1 7 0v2" />
  </Svg>
);

export const IconCoins = (p: IconProps) => (
  <Svg {...p}>
    <ellipse cx="9" cy="7" rx="6" ry="3.2" />
    <path d="M3 7v4c0 1.8 2.7 3.2 6 3.2s6-1.4 6-3.2V7" />
    <ellipse cx="16.5" cy="14.5" rx="4.5" ry="2.4" />
    <path d="M12 14.5v3c0 1.3 2 2.4 4.5 2.4s4.5-1.1 4.5-2.4v-3" />
  </Svg>
);

export const IconCreditCard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <line x1="2.5" y1="9.5" x2="21.5" y2="9.5" />
    <line x1="5.5" y1="15" x2="10" y2="15" />
  </Svg>
);

export const IconWallet = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.2A1.7 1.7 0 0 1 4.7 6.5h12.6A1.7 1.7 0 0 1 19 8.2V9H3z" />
    <path d="M3 9h16.5A1.5 1.5 0 0 1 21 10.5v8A1.5 1.5 0 0 1 19.5 20H4.5A1.5 1.5 0 0 1 3 18.5V9z" />
    <circle cx="16.2" cy="14.3" r="1.1" />
  </Svg>
);

export const IconCalculator = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="2.5" width="14" height="19" rx="2" />
    <line x1="7.5" y1="6.5" x2="16.5" y2="6.5" />
    <circle cx="8.2" cy="11.2" r="0.9" />
    <circle cx="12" cy="11.2" r="0.9" />
    <circle cx="15.8" cy="11.2" r="0.9" />
    <circle cx="8.2" cy="15" r="0.9" />
    <circle cx="12" cy="15" r="0.9" />
    <circle cx="15.8" cy="15" r="0.9" />
  </Svg>
);

export const IconBarChart = (p: IconProps) => (
  <Svg {...p}>
    <line x1="4" y1="20" x2="4" y2="12" />
    <line x1="10" y1="20" x2="10" y2="6" />
    <line x1="16" y1="20" x2="16" y2="15" />
    <line x1="20.5" y1="20" x2="3.5" y2="20" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v3M12 18.5v3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M2.5 12h3M18.5 12h3M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" />
  </Svg>
);

export const IconIdCard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.2" />
    <circle cx="9" cy="11" r="2.1" />
    <path d="M6 15.8c0-1.7 1.3-2.9 3-2.9s3 1.2 3 2.9" />
    <line x1="14" y1="9.3" x2="18" y2="9.3" />
    <line x1="14" y1="13" x2="18" y2="13" />
  </Svg>
);

export const IconList = (p: IconProps) => (
  <Svg {...p}>
    <line x1="8.5" y1="6.5" x2="20" y2="6.5" />
    <line x1="8.5" y1="12" x2="20" y2="12" />
    <line x1="8.5" y1="17.5" x2="20" y2="17.5" />
    <circle cx="4.3" cy="6.5" r="1.1" />
    <circle cx="4.3" cy="12" r="1.1" />
    <circle cx="4.3" cy="17.5" r="1.1" />
  </Svg>
);

export const IconHourglass = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 2.5h12M6 21.5h12" />
    <path d="M7 2.5v4.2c0 1.6 1 3 2.6 3.9l2.4 1.4 2.4-1.4c1.6-.9 2.6-2.3 2.6-3.9V2.5" />
    <path d="M7 21.5v-4.2c0-1.6 1-3 2.6-3.9l2.4-1.4 2.4 1.4c1.6.9 2.6 2.3 2.6 3.9v4.2" />
  </Svg>
);

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 2.5l7.5 3v5.5c0 5-3.2 8.6-7.5 10.5-4.3-1.9-7.5-5.5-7.5-10.5V5.5l7.5-3z" />
    <path d="M9 12l2.2 2.2L15.5 9.5" />
  </Svg>
);

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" />
  </Svg>
);

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4.5" />
    <path d="M12 2.5v2.5M12 19v2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2.5 12H5M19 12h2.5M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
  </Svg>
);

export const IconCamera = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8.5a1.5 1.5 0 0 1 1.5-1.5h1.6l1-2h7.8l1 2h1.6A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9z" />
    <circle cx="12" cy="13" r="3.4" />
  </Svg>
);

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <line x1="5" y1="5" x2="19" y2="19" />
    <line x1="19" y1="5" x2="5" y2="19" />
  </Svg>
);

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <line x1="3.5" y1="6.5" x2="20.5" y2="6.5" />
    <line x1="3.5" y1="12" x2="20.5" y2="12" />
    <line x1="3.5" y1="17.5" x2="20.5" y2="17.5" />
  </Svg>
);

export const IconPalette = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H17a4 4 0 0 0 4-4c0-4.4-4-8.2-9-8.2Z" />
    <circle cx="7.5" cy="11" r="1" />
    <circle cx="10.5" cy="7" r="1" />
    <circle cx="15" cy="7.5" r="1" />
  </Svg>
);
