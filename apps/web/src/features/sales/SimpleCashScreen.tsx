import { breakdownChange, spokenAmount, type PaymentMethod } from "@gestion-boutique/core";
import { getCurrency } from "@gestion-boutique/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconBanknote, IconCamera, IconPhone, IconSpeaker, IconSpeakerOff, IconTrash } from "../../components/icons";
import { amountStyle, inputStyle } from "../../components/sharedStyles";
import { formatAmount, formatMoney } from "../../lib/format";
import { isSpeechSupported, loadVoiceEnabled, saveVoiceEnabled, speak, stopSpeaking } from "../../lib/speech";

// Caisse simplifiée : pour les employés qui lisent peu. Grosses tuiles avec photo, quantités en gros boutons,
// deux moyens de paiement seulement (espèces, mobile), rendu de monnaie dessiné en billets et pièces, et une voix
// facultative qui dit le total et la monnaie. Ce composant ne fait que l'AFFICHAGE : le panier, le calcul du total
// (promotions comprises) et l'encaissement restent ceux de SalesPage — une vente simplifiée est une vente normale.

export interface SimpleTile {
  key: string;
  label: string;
  price: number;
  imageDataUrl: string | null;
  tint: number;
  initials: string;
  inCart: number;
  onAdd: () => void;
}

export interface SimpleLine {
  variantId: number;
  name: string;
  quantity: number;
  total: number;
}

interface Props {
  tiles: SimpleTile[];
  search: string;
  onSearch: (value: string) => void;
  lines: SimpleLine[];
  total: number;
  onIncrease: (variantId: number) => void;
  onDecrease: (variantId: number) => void;
  onRemove: (variantId: number) => void;
  paymentMethod: PaymentMethod;
  onPaymentMethod: (method: PaymentMethod) => void;
  cashReceived: string;
  onCashReceived: (value: string) => void;
  needsPrescription: boolean;
  error: string | null;
  checkingOut: boolean;
  onCheckout: () => void;
  onCamera: (() => void) | null;
  lastSaleNumber: string | null;
}

const BIG_BUTTON = { minHeight: 56, borderRadius: "var(--radius-md)", cursor: "pointer", fontWeight: 700 } as const;

function ChangeIcons({ amount }: { amount: number }) {
  const { t } = useTranslation();
  const currency = getCurrency();
  const { parts, rest } = useMemo(() => breakdownChange(amount, currency.denominations), [amount, currency]);
  if (parts.length === 0 && rest === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "center" }}>
      {parts.map((part, i) => {
        const isCoin = part.value <= currency.coinsUpTo;
        return (
          <span key={part.value} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              aria-hidden="true"
              style={{
                ...amountStyle,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: isCoin ? 52 : 96,
                height: isCoin ? 52 : 52,
                boxSizing: "border-box",
                borderRadius: isCoin ? "50%" : 8,
                border: "2px solid var(--color-rule-strong)",
                background: `var(--tint-${(i % 5) + 1})`,
                color: "var(--color-text)",
                fontSize: part.value >= 10000 ? 15 : 17,
                fontWeight: 700,
              }}
            >
              {formatAmount(part.value).replace(/[.,]00$/, "")}
            </span>
            {part.count > 1 && <span style={{ ...amountStyle, fontSize: 22, fontWeight: 700 }}>×{part.count}</span>}
          </span>
        );
      })}
      {rest > 0 && <span style={{ ...amountStyle, fontSize: 16, color: "var(--color-text-muted)" }}>{t("simpleCash.rest", { amount: formatMoney(rest) })}</span>}
    </div>
  );
}

export function SimpleCashScreen(props: Props) {
  const { t, i18n } = useTranslation();
  const {
    tiles, search, onSearch, lines, total, onIncrease, onDecrease, onRemove, paymentMethod, onPaymentMethod,
    cashReceived, onCashReceived, needsPrescription, error, checkingOut, onCheckout, onCamera, lastSaleNumber,
  } = props;
  const [step, setStep] = useState<"shop" | "pay">("shop");
  const [voice, setVoice] = useState(loadVoiceEnabled);
  const speechOk = isSpeechSupported();
  const lang = i18n.language;
  const say = (text: string) => {
    if (voice) speak(text, lang);
  };

  // Seuls l'espèce et le mobile existent ici : une carte ou un crédit choisi dans la caisse normale est ramené à l'espèce.
  useEffect(() => {
    if (paymentMethod !== "cash" && paymentMethod !== "mobile_money") onPaymentMethod("cash");
  }, [paymentMethod, onPaymentMethod]);

  // Panier vidé (vente enregistrée, ou tout retiré) : retour aux produits.
  useEffect(() => {
    if (lines.length === 0) setStep("shop");
  }, [lines.length]);

  // Vente enregistrée : un mot, pour que le client sache que c'est terminé.
  const lastSaleSeen = useRef(lastSaleNumber);
  useEffect(() => {
    if (lastSaleNumber && lastSaleNumber !== lastSaleSeen.current) say(t("simpleCash.thanks"));
    lastSaleSeen.current = lastSaleNumber;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSaleNumber]);

  // Le bruit d'une synthèse ne doit jamais continuer après avoir quitté l'écran.
  useEffect(() => stopSpeaking, []);

  const toggleVoice = () => {
    const next = !voice;
    setVoice(next);
    saveVoiceEnabled(next);
    if (!next) stopSpeaking();
    else speak(t("simpleCash.voiceOnPhrase"), lang);
  };

  const sayTotal = () => speak(t("simpleCash.sayTotal", { amount: spokenAmount(total, lang.startsWith("en") ? "en" : "fr", getCurrency()) }), lang);
  const spoken = (amount: number) => spokenAmount(amount, lang.startsWith("en") ? "en" : "fr", getCurrency());

  const received = cashReceived === "" ? null : Number(cashReceived);
  const changeDue = received === null ? 0 : Math.max(0, Math.round((received - total) * 100) / 100);
  const notEnough = paymentMethod === "cash" && received !== null && received < total;

  const goPay = () => {
    setStep("pay");
    say(t("simpleCash.sayTotal", { amount: spoken(total) }));
  };

  const chooseReceived = (value: number) => {
    onCashReceived(String(Math.round(value * 100) / 100));
    if (value >= total) {
      const change = Math.round((value - total) * 100) / 100;
      say(change > 0 ? t("simpleCash.sayChange", { amount: spoken(change) }) : t("simpleCash.sayExact"));
    }
  };

  const quickAmounts = getCurrency().cashQuickAmounts.filter((amount) => amount >= total);
  const voiceButton = speechOk ? (
    <button
      type="button"
      onClick={toggleVoice}
      aria-pressed={voice}
      aria-label={voice ? t("simpleCash.voiceOff") : t("simpleCash.voiceOn")}
      title={voice ? t("simpleCash.voiceOff") : t("simpleCash.voiceOn")}
      style={{ ...BIG_BUTTON, width: 56, border: "1px solid var(--color-border)", background: voice ? "var(--color-text)" : "transparent", color: voice ? "var(--color-bg)" : "var(--color-text)" }}
    >
      {voice ? <IconSpeaker size={26} /> : <IconSpeakerOff size={26} />}
    </button>
  ) : null;

  if (step === "pay") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 560, margin: "0 auto" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: "var(--color-text-muted)" }}>{t("simpleCash.total")}</div>
          <div style={{ ...amountStyle, fontSize: 56, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{formatMoney(total)}</div>
          {speechOk && (
            <button type="button" onClick={sayTotal} style={{ ...BIG_BUTTON, marginTop: 8, padding: "0 18px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text)", display: "inline-flex", alignItems: "center", gap: 8 }}>
              <IconSpeaker size={22} /> {t("simpleCash.hear")}
            </button>
          )}
        </div>

        <div role="group" aria-label={t("sales.paymentMethod")} style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
          {([
            { value: "cash" as const, label: t("sales.paymentMethods.cash"), icon: <IconBanknote size={34} /> },
            { value: "mobile_money" as const, label: t("sales.paymentMethods.mobile_money"), icon: <IconPhone size={34} /> },
          ]).map((m) => (
            <button
              key={m.value}
              type="button"
              aria-pressed={paymentMethod === m.value}
              onClick={() => {
                onPaymentMethod(m.value);
                if (m.value === "mobile_money") say(t("simpleCash.mobileHint"));
              }}
              style={{
                ...BIG_BUTTON,
                minHeight: 92,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                fontSize: 18,
                border: "2px solid var(--color-text)",
                background: paymentMethod === m.value ? "var(--color-text)" : "transparent",
                color: paymentMethod === m.value ? "var(--color-bg)" : "var(--color-text)",
              }}
            >
              {m.icon}
              {m.label}
            </button>
          ))}
        </div>

        {paymentMethod === "cash" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 18, fontWeight: 700, textAlign: "center" }}>{t("simpleCash.clientGives")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))", gap: 10 }}>
              {[total, ...quickAmounts.filter((amount) => amount !== total)].map((value, index) => {
                const selected = received === value;
                return (
                  <button
                    key={`${value}-${index}`}
                    type="button"
                    onClick={() => chooseReceived(value)}
                    style={{
                      ...BIG_BUTTON,
                      ...amountStyle,
                      fontSize: 19,
                      border: "2px solid var(--color-rule-strong)",
                      background: selected ? "var(--color-text)" : "var(--color-bg-elevated)",
                      color: selected ? "var(--color-bg)" : "var(--color-text)",
                    }}
                  >
                    {index === 0 ? t("sales.exactAmount") : formatAmount(value).replace(/[.,]00$/, "")}
                  </button>
                );
              })}
            </div>
            <input
              style={{ ...inputStyle, ...amountStyle, textAlign: "center", fontSize: 24, fontWeight: 700, height: 56, marginTop: 0 }}
              type="number"
              step="any"
              inputMode="decimal"
              value={cashReceived}
              onChange={(e) => onCashReceived(e.target.value)}
              placeholder={t("simpleCash.otherAmount")}
              aria-label={t("simpleCash.clientGives")}
            />
            {notEnough && <p style={{ color: "var(--color-danger)", textAlign: "center", fontWeight: 600, margin: 0 }}>{t("simpleCash.notEnough")}</p>}
            {received !== null && !notEnough && (
              <div style={{ border: "3px solid var(--color-accent)", borderRadius: "var(--radius-md)", padding: "14px 12px", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--color-accent)" }}>{t("simpleCash.changeToGive")}</div>
                <div style={{ ...amountStyle, fontSize: 46, fontWeight: 700, color: "var(--color-accent)", lineHeight: 1.1 }}>{formatMoney(changeDue)}</div>
                <ChangeIcons amount={changeDue} />
              </div>
            )}
          </div>
        ) : (
          <p style={{ textAlign: "center", fontSize: 18, fontWeight: 600, margin: 0 }}>{t("simpleCash.mobileHint")}</p>
        )}

        {error && <p style={{ color: "var(--color-danger)", fontWeight: 600, margin: 0 }}>{error}</p>}

        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" onClick={() => setStep("shop")} style={{ ...BIG_BUTTON, flex: "0 0 auto", padding: "0 22px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text)", fontSize: 17 }}>
            {t("simpleCash.back")}
          </button>
          <button
            type="button"
            onClick={onCheckout}
            disabled={checkingOut || notEnough || needsPrescription}
            style={{ ...BIG_BUTTON, flex: 1, minHeight: 68, border: "none", background: "var(--gradient-accent)", color: "var(--color-on-accent)", fontSize: 21, opacity: checkingOut || notEnough || needsPrescription ? 0.5 : 1 }}
          >
            {checkingOut ? t("sales.checkingOut") : t("simpleCash.confirm")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="cart-layout-grid">
      <div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ ...inputStyle, marginTop: 0, height: 56, fontSize: 18, flex: 1 }}
            placeholder={t("sales.searchProductPlaceholder")}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
          {onCamera && (
            <button type="button" onClick={onCamera} aria-label={t("sales.scanCamera")} title={t("sales.scanCamera")} style={{ ...BIG_BUTTON, width: 56, border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text)" }}>
              <IconCamera size={26} />
            </button>
          )}
          {voiceButton}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12, marginTop: 16 }}>
          {tiles.map((tile) => (
            <button
              key={tile.key}
              type="button"
              onClick={tile.onAdd}
              style={{ position: "relative", display: "flex", flexDirection: "column", padding: 0, textAlign: "left", border: "2px solid var(--color-border)", borderRadius: "var(--radius-md)", background: "var(--color-bg-elevated)", color: "var(--color-text)", overflow: "hidden", cursor: "pointer" }}
            >
              {tile.imageDataUrl ? (
                <img src={tile.imageDataUrl} alt="" style={{ width: "100%", height: 110, objectFit: "cover", display: "block" }} />
              ) : (
                <span aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 110, background: `var(--tint-${tile.tint})`, fontSize: 44, fontWeight: 700 }}>
                  {tile.initials}
                </span>
              )}
              <span style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 12px 12px" }}>
                <span style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.2, minHeight: 38 }}>{tile.label}</span>
                <span style={{ ...amountStyle, fontSize: 20, fontWeight: 700 }}>{formatMoney(tile.price)}</span>
              </span>
              {tile.inCart > 0 && (
                <span style={{ ...amountStyle, position: "absolute", top: 8, right: 8, minWidth: 34, height: 34, boxSizing: "border-box", padding: "0 9px", borderRadius: 8, background: "var(--color-text)", color: "var(--color-bg)", fontSize: 18, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  ×{tile.inCart}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, alignSelf: "start", border: "2px solid var(--color-border)", borderRadius: "var(--radius-lg)", background: "var(--color-bg-elevated)", padding: 14 }}>
        {lines.length === 0 ? (
          <p style={{ margin: "14px 0", textAlign: "center", fontFamily: "var(--font-hand)", fontSize: 26, fontWeight: 600, color: "var(--color-text-muted)" }}>{t("simpleCash.empty")}</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 360, overflowY: "auto" }}>
            {lines.map((line) => (
              <div key={line.variantId} style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 10, borderBottom: "1px dashed var(--color-rule-strong)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 17, fontWeight: 600 }}>
                  <span style={{ overflowWrap: "anywhere" }}>{line.name}</span>
                  <span style={{ ...amountStyle, whiteSpace: "nowrap" }}>{formatAmount(line.total)}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button type="button" aria-label={t("sales.removeOne")} onClick={() => (line.quantity > 1 ? onDecrease(line.variantId) : onRemove(line.variantId))} style={{ ...BIG_BUTTON, width: 56, border: "2px solid var(--color-rule-strong)", background: "transparent", color: "var(--color-text)", fontSize: 28 }}>
                    −
                  </button>
                  <span style={{ ...amountStyle, minWidth: 40, textAlign: "center", fontSize: 26, fontWeight: 700 }}>{line.quantity}</span>
                  <button type="button" aria-label={t("sales.addOne")} onClick={() => onIncrease(line.variantId)} style={{ ...BIG_BUTTON, width: 56, border: "2px solid var(--color-rule-strong)", background: "transparent", color: "var(--color-text)", fontSize: 28 }}>
                    +
                  </button>
                  <span style={{ flex: 1 }} />
                  <button type="button" aria-label={t("simpleCash.remove")} title={t("simpleCash.remove")} onClick={() => onRemove(line.variantId)} style={{ ...BIG_BUTTON, width: 56, border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-danger)" }}>
                    <IconTrash size={24} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <span style={{ fontSize: 20, fontWeight: 700 }}>{t("simpleCash.total")}</span>
          <span style={{ ...amountStyle, fontSize: 38, fontWeight: 700, letterSpacing: "-0.02em" }}>{formatMoney(total)}</span>
        </div>
        {needsPrescription && <p style={{ color: "var(--color-warning)", fontWeight: 600, margin: 0 }}>{t("simpleCash.prescription")}</p>}
        <button
          type="button"
          onClick={goPay}
          disabled={lines.length === 0 || needsPrescription}
          style={{ ...BIG_BUTTON, minHeight: 68, border: "none", background: "var(--gradient-accent)", color: "var(--color-on-accent)", fontSize: 22, opacity: lines.length === 0 || needsPrescription ? 0.5 : 1 }}
        >
          {t("simpleCash.pay")}
        </button>
      </div>
    </div>
  );
}
