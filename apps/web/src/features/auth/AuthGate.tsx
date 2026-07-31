import { ensureDefaultLocations, ensureDefaultRoles, getSettings, hasAnyUser } from "@gestion-boutique/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDatabase } from "../../app/DatabaseProvider";
import { useSessionStore } from "../../stores/session";
import { LoginScreen } from "./LoginScreen";
import { ModuleSetupScreen } from "./ModuleSetupScreen";
import { PinLockScreen } from "./PinLockScreen";
import { SetupAdminScreen } from "./SetupAdminScreen";

export function AuthGate({ children }: { children: ReactNode }) {
  const db = useDatabase();
  const user = useSessionStore((s) => s.user);
  const isLocked = useSessionStore((s) => s.isLocked);
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [modulesConfigured, setModulesConfigured] = useState(false);

  useEffect(() => {
    // Ne revérifie que tant qu'aucune session n'est active — une fois connecté,
    // pas besoin de relire cette info. Sans le dépendre de `user`, une
    // déconnexion après la création du tout premier compte réaffichait
    // "Créer le compte administrateur" au lieu de l'écran de connexion, car
    // cette valeur n'était calculée qu'une seule fois, au tout premier montage
    // (base encore vide à ce moment-là).
    if (user) return;
    let cancelled = false;
    hasAnyUser(db).then((exists) => {
      if (!cancelled) setNeedsSetup(!exists);
    });
    return () => {
      cancelled = true;
    };
  }, [db, user]);

  const ready = !!user && !isLocked;
  const bootstrapStarted = useRef(false);

  useEffect(() => {
    if (!ready || bootstrapStarted.current) return;
    bootstrapStarted.current = true;
    // ensureDefaultRoles rattrape aussi les permissions manquantes sur les
    // rôles déjà existants (installation déjà déployée) — voir RolesService.ts.
    // Le compte déjà connecté dans cette session garde ses permissions au
    // moment du login ; le rattrapage prend effet à la prochaine connexion.
    Promise.all([ensureDefaultLocations(db), ensureDefaultRoles(db)])
      .then(() => getSettings(db))
      .then((settings) => {
        setModulesConfigured(settings.modulesConfigured);
        setBootstrapped(true);
      });
  }, [db, ready]);

  if (needsSetup === null) {
    return <div style={{ padding: 24 }}>Chargement...</div>;
  }

  // `user` prime sur `needsSetup` : dès que SetupAdminScreen a créé le premier
  // compte et appelé setUser(), il ne faut plus revenir sur cet écran même si
  // `needsSetup` (calculé une seule fois au montage) n'a pas été recalculé.
  if (!user) {
    return needsSetup ? <SetupAdminScreen /> : <LoginScreen />;
  }

  if (isLocked) {
    return <PinLockScreen />;
  }

  if (!bootstrapped) {
    return <div style={{ padding: 24 }}>Chargement...</div>;
  }

  if (!modulesConfigured) {
    return <ModuleSetupScreen onDone={() => setModulesConfigured(true)} />;
  }

  return <>{children}</>;
}
