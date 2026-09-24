const RECENT_DISPLAY_LIMIT = 8;

export function fuzzyMatch(query: string, text: string): boolean {
  const needle = normalize(query);
  const hay = normalize(text);
  if (needle.length === 0) {
    return true;
  }
  if (hay.includes(needle)) {
    return true;
  }
  const tokens = needle.split(" ");
  return tokens.every((token) => tokenHits(token, hay));
}

export function alphabetical(values: readonly string[]): string[] {
  return values.slice().sort((a, b) => a.localeCompare(b, "en-US", { sensitivity: "base" }));
}

export function pickSuggestions(valuesInRecentOrder: readonly string[], query: string, limit = RECENT_DISPLAY_LIMIT): string[] {
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const value of valuesInRecentOrder) {
    const key = normalize(value);
    if (key.length === 0 || seen.has(key) || !fuzzyMatch(query, value)) {
      continue;
    }
    seen.add(key);
    matches.push(value);
    if (matches.length >= limit) {
      break;
    }
  }
  return alphabetical(matches);
}

function tokenHits(token: string, hay: string): boolean {
  if (token.length === 0 || hay.includes(token)) {
    return true;
  }
  if (token.length >= 2 && isSubsequence(token, hay)) {
    return true;
  }
  if (token.length < 4) {
    return false;
  }
  return hay.split(" ").some((word) => editDistanceAtMost(token, word, 1));
}

function isSubsequence(needle: string, hay: string): boolean {
  let index = 0;
  for (const char of hay) {
    if (char === needle[index]) {
      index += 1;
    }
    if (index === needle.length) {
      return true;
    }
  }
  return false;
}

function editDistanceAtMost(left: string, right: string, max: number): boolean {
  if (Math.abs(left.length - right.length) > max) {
    return false;
  }
  if (left.length === right.length) {
    const mismatches: number[] = [];
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        mismatches.push(index);
        if (mismatches.length > max + 1) {
          return false;
        }
      }
    }
    if (mismatches.length <= max) {
      return true;
    }
    if (max < 1 || mismatches.length !== 2) {
      return false;
    }
    const first = mismatches[0] ?? 0;
    const second = mismatches[1] ?? 0;
    return second === first + 1 && left[first] === right[second] && left[second] === right[first];
  }
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  let shortIndex = 0;
  let longIndex = 0;
  let edits = 0;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > max) {
      return false;
    }
    longIndex += 1;
  }
  edits += longer.length - longIndex + (shorter.length - shortIndex);
  return edits <= max;
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}
