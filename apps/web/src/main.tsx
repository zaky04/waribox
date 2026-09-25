import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
// Polices embarquées (l'app fonctionne hors ligne : pas de Google Fonts) —
// sous-ensemble latin uniquement, qui couvre le français.
import "@fontsource/familjen-grotesk/latin-400.css";
import "@fontsource/familjen-grotesk/latin-500.css";
import "@fontsource/familjen-grotesk/latin-600.css";
import "@fontsource/familjen-grotesk/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "@fontsource/caveat/latin-600.css";
import "./app/index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
