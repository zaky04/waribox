import type { RasterBitmap } from "./escpos";

// Poids de diffusion d'erreur Floyd-Steinberg : droite, bas-gauche, bas, bas-droite.
const FS_RIGHT = 7 / 16;
const FS_BOTTOM_LEFT = 3 / 16;
const FS_BOTTOM = 5 / 16;
const FS_BOTTOM_RIGHT = 1 / 16;

// Convertit le logo de l'entreprise (data URL) en bitmap 1 bit/pixel prêt pour
// EscPosBuilder.image() — redimensionné à la largeur du papier configuré et
// tramé (Floyd-Steinberg) pour rester lisible sur une imprimante thermique
// monochrome malgré les dégradés/l'anti-aliasing du logo source.
export async function rasterizeLogo(
  dataUrl: string,
  widthDots: number,
  maxHeightDots = 200,
): Promise<RasterBitmap> {
  const image = await loadImage(dataUrl);
  const heightDots = Math.max(
    1,
    Math.min(maxHeightDots, Math.round((image.height * widthDots) / image.width)),
  );

  const canvas = document.createElement("canvas");
  canvas.width = widthDots;
  canvas.height = heightDots;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Contexte de rendu 2D indisponible.");

  // Fond blanc avant de dessiner : les pixels transparents du logo source
  // doivent s'imprimer en blanc (aucun point), jamais en noir.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, widthDots, heightDots);
  ctx.drawImage(image, 0, 0, widthDots, heightDots);

  const { data } = ctx.getImageData(0, 0, widthDots, heightDots);
  const gray = new Float32Array(widthDots * heightDots);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = 0.299 * (data[i * 4] ?? 0) + 0.587 * (data[i * 4 + 1] ?? 0) + 0.114 * (data[i * 4 + 2] ?? 0);
  }

  const widthBytes = Math.ceil(widthDots / 8);
  const packed = new Uint8Array(widthBytes * heightDots);

  for (let y = 0; y < heightDots; y++) {
    for (let x = 0; x < widthDots; x++) {
      const idx = y * widthDots + x;
      const old = gray[idx] ?? 0;
      const isBlack = old < 128;
      const error = isBlack ? old : old - 255;

      if (isBlack) {
        const byteIndex = y * widthBytes + (x >> 3);
        packed[byteIndex] = (packed[byteIndex] ?? 0) | (0x80 >> (x & 7));
      }

      if (x + 1 < widthDots) gray[idx + 1] = (gray[idx + 1] ?? 0) + error * FS_RIGHT;
      if (y + 1 < heightDots) {
        if (x - 1 >= 0) {
          gray[idx - 1 + widthDots] = (gray[idx - 1 + widthDots] ?? 0) + error * FS_BOTTOM_LEFT;
        }
        gray[idx + widthDots] = (gray[idx + widthDots] ?? 0) + error * FS_BOTTOM;
        if (x + 1 < widthDots) {
          gray[idx + 1 + widthDots] = (gray[idx + 1 + widthDots] ?? 0) + error * FS_BOTTOM_RIGHT;
        }
      }
    }
  }

  return { widthBytes, heightDots, data: packed };
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image de logo invalide."));
    image.src = dataUrl;
  });
}
