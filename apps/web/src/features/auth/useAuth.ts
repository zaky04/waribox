import { impersonateUser, verifyPassword, verifyPin } from "@gestion-boutique/core";
import { t } from "@gestion-boutique/i18n";
import { useDatabase } from "../../app/DatabaseProvider";
import { useSessionStore } from "../../stores/session";

export function useAuth() {
  const db = useDatabase();
  const user = useSessionStore((s) => s.user);
  const isLocked = useSessionStore((s) => s.isLocked);
  const impersonatorUser = useSessionStore((s) => s.impersonatorUser);
  const setUser = useSessionStore((s) => s.setUser);
  const unlock = useSessionStore((s) => s.unlock);
  const lock = useSessionStore((s) => s.lock);
  const logout = useSessionStore((s) => s.logout);
  const impersonate = useSessionStore((s) => s.impersonate);
  const returnToSelf = useSessionStore((s) => s.returnToSelf);
  const currentStoreId = useSessionStore((s) => s.currentStoreId);
  const setCurrentStore = useSessionStore((s) => s.setCurrentStore);

  async function login(identifier: string, password: string) {
    const authUser = await verifyPassword(db, identifier, password);
    if (!authUser) throw new Error(t("auth.errors.invalidCredentials"));
    setUser(authUser);
  }

  async function unlockWithPin(pin: string) {
    if (!user) throw new Error(t("auth.errors.noActiveSession"));
    const valid = await verifyPin(db, user.id, pin);
    if (!valid) throw new Error(t("auth.errors.wrongPin"));
    unlock();
  }

  async function impersonateUserById(targetUserId: number) {
    if (!user) throw new Error(t("auth.errors.noActiveSession"));
    const target = await impersonateUser(db, targetUserId, user.permissions, user.id);
    impersonate(target);
  }

  return {
    user,
    isLocked,
    isImpersonating: impersonatorUser !== null,
    impersonatorUser,
    login,
    unlockWithPin,
    lock,
    logout,
    impersonateUserById,
    returnToSelf,
    currentStoreId,
    setCurrentStore,
  };
}
