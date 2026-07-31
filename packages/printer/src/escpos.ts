// Constructeur de commandes ESC/POS — le protocole binaire compris par la
// quasi-totalité des imprimantes thermiques de tickets (Bluetooth, USB, réseau).
const ESC = 0x1b;
const GS = 0x1d;

export type Alignment = "left" | "center" | "right";

// Bitmap 1 bit/pixel déjà empaqueté en octets (8 pixels par octet, MSB en
// premier) — voir packages/printer/src/logo.ts pour la conversion depuis une
// image source.
export interface RasterBitmap {
  widthBytes: number;
  heightDots: number;
  data: Uint8Array;
}

// Décompose les caractères accentués en base + diacritique (NFD) puis
// supprime les diacritiques, et déligature manuellement œ/Œ (non couverts
// par la décomposition NFD). Résultat : ASCII pur, imprimable partout.
function toPrinterAscii(value: string): string {
  return value
    .replace(/œ/g, "oe")
    .replace(/Œ/g, "OE")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export class EscPosBuilder {
  private bytes: number[] = [];

  init(): this {
    this.bytes.push(ESC, 0x40); // ESC @ — réinitialise l'imprimante
    return this;
  }

  text(value: string): this {
    // Les imprimantes ESC/POS attendent une page de code 8 bits (CP437,
    // CP1252...), jamais de l'UTF-8 — envoyer les octets UTF-8 bruts d'un
    // caractère accentué produit des symboles illisibles sur le papier. Le
    // modèle exact du client n'étant pas connu à l'avance, on neutralise les
    // accents plutôt que de parier sur une page de code précise : le rendu
    // reste correct sur n'importe quelle imprimante, au prix des accents.
    const ascii = toPrinterAscii(value);
    for (let i = 0; i < ascii.length; i++) {
      this.bytes.push(ascii.charCodeAt(i) & 0xff);
    }
    return this;
  }

  newline(count = 1): this {
    for (let i = 0; i < count; i++) this.bytes.push(0x0a);
    return this;
  }

  bold(on: boolean): this {
    this.bytes.push(ESC, 0x45, on ? 1 : 0);
    return this;
  }

  align(position: Alignment): this {
    const map: Record<Alignment, number> = { left: 0, center: 1, right: 2 };
    this.bytes.push(ESC, 0x61, map[position]);
    return this;
  }

  doubleHeight(on: boolean): this {
    this.bytes.push(GS, 0x21, on ? 0x11 : 0x00);
    return this;
  }

  // Image bitmap (GS v 0) — commande standard ESC/POS d'impression d'une image
  // raster monochrome, utilisée ici pour le logo de l'entreprise. `data` doit
  // déjà être empaqueté en 1 bit/pixel (voir logo.ts), 1 = point noir imprimé.
  image(bitmap: RasterBitmap): this {
    const { widthBytes, heightDots, data } = bitmap;
    this.bytes.push(
      GS,
      0x76,
      0x30,
      0x00,
      widthBytes & 0xff,
      (widthBytes >> 8) & 0xff,
      heightDots & 0xff,
      (heightDots >> 8) & 0xff,
    );
    for (let i = 0; i < data.length; i++) {
      this.bytes.push(data[i] ?? 0);
    }
    return this;
  }

  // Découpe le papier (la plupart des imprimantes ignorent cette commande
  // si elles n'ont pas de massicot automatique — sans danger).
  cut(): this {
    this.bytes.push(GS, 0x56, 0x00);
    return this;
  }

  // Impulsion sur la broche 2 du connecteur tiroir-caisse (standard du secteur :
  // ESC p m t1 t2). Fonctionne pour un tiroir branché sur le port RJ11 de
  // l'imprimante — c'est le mécanisme d'ouverture le plus répandu.
  kickDrawer(): this {
    this.bytes.push(ESC, 0x70, 0x00, 0x19, 0xfa);
    return this;
  }

  build(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}
