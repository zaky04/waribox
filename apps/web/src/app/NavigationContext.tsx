import { createContext, useContext } from "react";
import type { NavTab } from "./Nav";

// Permet à n'importe quel écran (même profond) de ramener l'utilisateur à un onglet — typiquement l'accueil — sans
// recevoir de prop. Sans fournisseur (écrans de connexion), `goTo` ne fait rien.
export interface NavigationApi {
  goTo: (tab: NavTab) => void;
}

export const NavigationContext = createContext<NavigationApi>({ goTo: () => undefined });

export function useNavigation(): NavigationApi {
  return useContext(NavigationContext);
}
