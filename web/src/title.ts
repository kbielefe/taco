/** Short words left lowercase in book titles, except first and last. */
const SMALL_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "but",
  "or",
  "nor",
  "for",
  "yet",
  "so",
  "as",
  "at",
  "by",
  "in",
  "of",
  "on",
  "to",
  "up",
  "via",
  "vs",
  "vs.",
]);

function capitalizeToken(token: string): string {
  if (token.length === 0) {
    return token;
  }
  return token.charAt(0).toLocaleUpperCase("en-US") + token.slice(1).toLocaleLowerCase("en-US");
}

function titleCaseWord(word: string, forceCapital: boolean): string {
  const lower = word.toLocaleLowerCase("en-US");
  if (!forceCapital && SMALL_WORDS.has(lower)) {
    return lower;
  }
  if (/[-&]/.test(word)) {
    return word
      .split(/([-&])/)
      .map((part) => (part === "-" || part === "&" ? part : capitalizeToken(part)))
      .join("");
  }
  return capitalizeToken(word);
}

/** Book-style title case for display. Does not change stored values. */
export function titleCase(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return text;
  }
  const words = trimmed.split(/\s+/);
  return words
    .map((word, index) => titleCaseWord(word, index === 0 || index === words.length - 1))
    .join(" ");
}
