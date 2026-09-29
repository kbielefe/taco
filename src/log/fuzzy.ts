const RECENT_DISPLAY_LIMIT = 8;
/** Above any contiguous-substring penalty (position and leftover length). */
const TOKEN_MATCH = 10_000_000;
const SUBSEQUENCE_TOKEN = 1_000_000;
const TYPO_TOKEN = 2_000_000;

export function fuzzyMatch(query: string, text: string): boolean {
  return matchRank(query, text) !== null;
}

/**
 * Lower is a closer match. `null` means it does not match.
 * An empty query ties everything at 0 so recency decides.
 */
export function matchRank(query: string, text: string): number | null {
  const needle = normalize(query);
  const hay = normalize(text);
  if (needle.length === 0) {
    return 0;
  }
  if (hay === needle) {
    return 0;
  }
  const at = hay.indexOf(needle);
  if (at >= 0) {
    return 1_000 + at * 1_000 + (hay.length - needle.length);
  }
  const tokens = needle.split(" ");
  let total = TOKEN_MATCH;
  for (const token of tokens) {
    const rank = tokenRank(token, hay);
    if (rank === null) {
      return null;
    }
    total += rank;
  }
  return total;
}

export function pickSuggestions(valuesInRecentOrder: readonly string[], query: string, limit = RECENT_DISPLAY_LIMIT): string[] {
  const ranked: { value: string; rank: number; order: number }[] = [];
  const seen = new Set<string>();
  for (const value of valuesInRecentOrder) {
    const key = normalize(value);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    const rank = matchRank(query, value);
    if (rank === null) {
      continue;
    }
    seen.add(key);
    ranked.push({ value, rank, order: ranked.length });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return ranked.slice(0, limit).map((item) => item.value);
}

function tokenRank(token: string, hay: string): number | null {
  const at = hay.indexOf(token);
  if (token.length === 0 || at >= 0) {
    return at * 1_000 + Math.max(0, hay.length - token.length);
  }
  const skipped = token.length >= 2 ? subsequenceSkip(token, hay) : null;
  if (skipped !== null) {
    return SUBSEQUENCE_TOKEN + skipped;
  }
  if (token.length < 4) {
    return null;
  }
  const typo = typoRank(token, hay);
  return typo === null ? null : TYPO_TOKEN + typo;
}

function subsequenceSkip(needle: string, hay: string): number | null {
  let index = 0;
  let start = -1;
  for (let cursor = 0; cursor < hay.length; cursor += 1) {
    if (hay[cursor] !== needle[index]) {
      continue;
    }
    if (start < 0) {
      start = cursor;
    }
    index += 1;
    if (index === needle.length) {
      return cursor - start - (needle.length - 1);
    }
  }
  return null;
}

function typoRank(token: string, hay: string): number | null {
  let best: number | null = null;
  let offset = 0;
  for (const word of hay.split(" ")) {
    if (editDistanceAtMost(token, word, 1)) {
      const score = Math.abs(token.length - word.length) * 1_000 + offset;
      if (best === null || score < best) {
        best = score;
      }
    }
    offset += word.length + 1;
  }
  return best;
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
