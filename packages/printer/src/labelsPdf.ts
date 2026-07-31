import JsBarcode from "jsbarcode";
import { jsPDF } from "jspdf";

export interface LabelInput {
  name: string;
  price: number;
  barcode: string;
  copies: number;
}

// Grille 3 colonnes x 8 lignes sur A4 — format d'étiquettes courant
// (comparable à une planche Avery), pas de configuration de taille dans
// cette première version.
const COLUMNS = 3;
const ROWS = 8;
const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;
const MARGIN_MM = 8;
const CELL_WIDTH_MM = (PAGE_WIDTH_MM - MARGIN_MM * 2) / COLUMNS;
const CELL_HEIGHT_MM = (PAGE_HEIGHT_MM - MARGIN_MM * 2) / ROWS;
const BARCODE_HEIGHT_MM = 14;

function renderBarcodeDataUrl(code: string): string {
  const canvas = document.createElement("canvas");
  JsBarcode(canvas, code, { format: "EAN13", displayValue: false, margin: 0 });
  return canvas.toDataURL("image/png");
}

export function buildLabelSheetPdf(labels: LabelInput[]): Blob {
  const doc = new jsPDF();
  let col = 0;
  let row = 0;

  for (const label of labels) {
    for (let i = 0; i < label.copies; i++) {
      if (row >= ROWS) {
        doc.addPage();
        row = 0;
        col = 0;
      }

      const x = MARGIN_MM + col * CELL_WIDTH_MM;
      const y = MARGIN_MM + row * CELL_HEIGHT_MM;

      doc.setFontSize(8);
      doc.setFont("helvetica", "bold");
      doc.text(label.name, x + CELL_WIDTH_MM / 2, y + 5, { align: "center", maxWidth: CELL_WIDTH_MM - 4 });

      try {
        const dataUrl = renderBarcodeDataUrl(label.barcode);
        doc.addImage(dataUrl, x + 4, y + 7, CELL_WIDTH_MM - 8, BARCODE_HEIGHT_MM);
      } catch {
        // Code-barres illisible par JsBarcode (format invalide) — l'étiquette
        // reste imprimée sans l'image plutôt que d'échouer toute la planche.
      }

      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.text(`${label.price.toFixed(0)}`, x + CELL_WIDTH_MM / 2, y + 7 + BARCODE_HEIGHT_MM + 5, {
        align: "center",
      });

      col++;
      if (col >= COLUMNS) {
        col = 0;
        row++;
      }
    }
  }

  return doc.output("blob");
}
