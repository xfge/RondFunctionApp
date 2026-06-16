/** Strip diacritics/accents and special letters for fuzzy name comparison. */
export function normalizeName(s: string): string {
    return s.trim().toLowerCase()
        .replace(/\u0131/g, "i")    // Turkish ı
        .replace(/\u0142/g, "l")    // Polish ł
        .replace(/\u00f8/g, "o")    // Scandinavian ø
        .replace(/\u0111/g, "d")    // Vietnamese/Croatian đ
        .replace(/\u00e6/g, "ae")   // æ ligature
        .replace(/\u00df/g, "ss")   // German ß
        .normalize("NFD").replace(/\p{M}/gu, "");
}
