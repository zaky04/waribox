// Lien "cliquer pour envoyer" wa.me — n'exige aucun compte/API WhatsApp
// Business, ouvre WhatsApp (app ou web) avec le message pré-rempli, un clic
// suffit ensuite pour l'envoyer.
export function buildWhatsAppLink(phone: string, countryCode: string | null | undefined, message: string): string {
  const digits = phone.replace(/\D/g, "");
  const code = (countryCode ?? "").replace(/\D/g, "");
  const withCountry = code && digits.startsWith(code) ? digits : `${code}${digits.replace(/^0+/, "")}`;
  return `https://wa.me/${withCountry}?text=${encodeURIComponent(message)}`;
}
