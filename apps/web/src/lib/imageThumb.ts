import { MAX_PRODUCT_IMAGE_CHARS } from "@gestion-boutique/core";

// Réduit une photo (souvent plusieurs Mo, sortie d'un téléphone) en vignette carrée JPEG : recadrée au centre,
// 128 px, qualité abaissée jusqu'à tenir sous la limite acceptée par le service (MAX_PRODUCT_IMAGE_CHARS).
const SIZE = 128;
const QUALITIES = [0.75, 0.6, 0.45, 0.3];

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image"));
    };
    img.src = url;
  });
}

export async function fileToThumbnail(file: File): Promise<string> {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error("image");
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("image");
  // Fond blanc : un PNG transparent deviendrait noir en JPEG.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
  for (const quality of QUALITIES) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length <= MAX_PRODUCT_IMAGE_CHARS) return dataUrl;
  }
  throw new Error("image");
}
