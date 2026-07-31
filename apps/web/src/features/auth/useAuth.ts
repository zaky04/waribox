import { verifyPassword, verifyPin } from "@gestion-boutique/core";
import { useDatabase } from "../../app/DatabaseProvider";
import { useSessionStore } from "../../stores/session";

export function useAuth() {
  const db = useDatabase();
  const user = useSessionStore((s) => s.user);
  const isLocked = useSessionStore((s) => s.isLocked);
  const setUser = useSessionStore((s) => s.setUser);
  const unlock = useSessionStore((s) => s.unlock);
  const lock = useSessionStore((s) => s.lock);
  const logout = useSessionStore((s) => s.logout);

  async function login(identifier: string, password: string) {
    const authUser = await verifyPassword(db, identifier, password);
    if (!authUser) throw new Error("Identifiants incorrects");
    setUser(authUser);
  }

  async function unlockWithPin(pin: string) {
    if (!user) throw new Error("Aucune session active");
    const valid = await verifyPin(db, user.id, pin);
    if (!valid) throw new Error("Code PIN incorrect");
    unlock();
  }

  return { user, isLocked, login, unlockWithPin, lock, logout };
}
