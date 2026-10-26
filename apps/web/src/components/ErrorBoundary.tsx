import { Component, type ErrorInfo, type ReactNode } from "react";
import { withTranslation, type WithTranslation } from "react-i18next";

// Sans filet, une exception pendant le rendu d'une page (donnée inattendue, puce
// de chargement en échec...) démonte TOUTE l'application : écran blanc, sans
// message, sans moyen de revenir autre qu'un rechargement. Ici l'erreur reste
// confinée à la zone enveloppée et propose de réessayer ou de recharger.
interface Props extends WithTranslation {
  children: ReactNode;
  /** Quand cette valeur change (ex. on change d'onglet), l'erreur est effacée. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

class ErrorBoundaryInner extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Erreur d'affichage", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    const { t } = this.props;
    if (!error) return this.props.children;
    return (
      <div role="alert" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12, maxWidth: 560 }}>
        <strong style={{ color: "var(--color-danger)" }}>{t("errorBoundary.title")}</strong>
        <p style={{ margin: 0, color: "var(--color-text-muted)" }}>{t("errorBoundary.hint")}</p>
        <code style={{ fontSize: 12, wordBreak: "break-word" }}>{error.message}</code>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => this.setState({ error: null })}>{t("errorBoundary.retry")}</button>
          <button onClick={() => window.location.reload()}>{t("errorBoundary.reload")}</button>
        </div>
      </div>
    );
  }
}

export const ErrorBoundary = withTranslation()(ErrorBoundaryInner);
