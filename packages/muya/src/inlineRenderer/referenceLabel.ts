/**
 * Produces the key used by CommonMark reference definitions and usages.
 * Whitespace is insignificant, as are backslash escapes of ASCII punctuation.
 */
export function normalizeReferenceLabel(label: string): string {
    return label
        .trim()
        .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
        .replace(/\s+/g, ' ')
        .toLowerCase();
}
