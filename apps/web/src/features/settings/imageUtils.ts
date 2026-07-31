// Redimensionne une image uploadée avant stockage en base (data URL) — évite
// qu'une photo de plusieurs Mo prise avec un téléphone gonfle la ligne SQLite
// business_settings, le logo n'ayant de toute façon jamais besoin d'être plus
// grand que ce qui s'affiche dans l'app ou s'imprime sur un ticket.
export function resizeImageToDataUrl(file: File, maxDimension = 400): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Lecture du fichier impossible."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("Image invalide."));
      image.onload = () => {
        const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Contexte de rendu 2D indisponible."));
          return;
        }
        ctx.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL("image/png"));
      };
      image.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
