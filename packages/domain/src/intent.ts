import type { ChatIntent, MealType } from './domain-types.js';

/**
 * Chat intent detection contract (issue 06).
 *
 * In production this runs server-side with Gemini Flash (key in server env
 * only), gated by a Hindi/Hinglish evaluation set. This module provides a
 * deterministic, dependency-free heuristic detector so the flow is testable
 * without the provider, and a clear fallback when the provider is unavailable.
 *
 * Crucially: detection only ever produces a PRIVATE suggestion for the author.
 * Nothing mutates until the author explicitly confirms it.
 */

const GROCERY_WORDS = [
  'chahiye',
  'chahiye.',
  'lao',
  'la do',
  'lando',
  'need',
  'get me',
  'buy',
  'grocery',
  'groceries',
  'kirana',
  'samán',
  'saman',
  'सामान',
  'किराना',
  'चाहिए',
  'लाओ',
  'ला दो',
  'मंगवा',
];

const MEAL_WORDS = ['change', 'swap', 'replace', 'banā', 'bana', 'बदल', 'बना', 'बदलो', 'रख'];

const MEAL_TYPE_WORDS: { word: string; mealType: MealType }[] = [
  { word: 'breakfast', mealType: 'breakfast' },
  { word: 'नाश्ता', mealType: 'breakfast' },
  { word: 'nashta', mealType: 'breakfast' },
  { word: 'lunch', mealType: 'lunch' },
  { word: 'दोपहर', mealType: 'lunch' },
  { word: 'dopahar', mealType: 'lunch' },
  { word: 'dinner', mealType: 'dinner' },
  { word: 'रात', mealType: 'dinner' },
  { word: 'raat', mealType: 'dinner' },
];

/** Detect a possible intent from a text/voice-transcript line. */
export function detectIntent(raw: string): ChatIntent {
  const text = raw.trim().toLowerCase();
  if (!text) return { kind: 'unknown' };

  if (GROCERY_WORDS.some((w) => text.includes(w))) {
    const item = extractItem(raw, GROCERY_WORDS);
    if (!item) {
      // "I need grocery" with no item → unknown so Chat asks "what do you need?"
      return { kind: 'grocery_request', item: '', quantity: null };
    }
    const quantity = extractQuantity(text);
    return { kind: 'grocery_request', item, quantity };
  }

  if (MEAL_WORDS.some((w) => text.includes(w))) {
    const mealType = MEAL_TYPE_WORDS.find((mt) => text.includes(mt.word))?.mealType ?? null;
    const meal = extractMealName(raw);
    return { kind: 'meal_change', date: null, mealType, meal };
  }

  return { kind: 'unknown' };
}

function extractItem(raw: string, triggers: string[]): string {
  let cleaned = raw;
  // Remove ALL trigger words found (Hindi places the item before the verb,
  // English after it; removing every trigger leaves the noun phrase).
  for (const w of triggers) {
    let idx = cleaned.toLowerCase().indexOf(w);
    while (idx >= 0) {
      cleaned = (cleaned.slice(0, idx) + ' ' + cleaned.slice(idx + w.length)).trim();
      idx = cleaned.toLowerCase().indexOf(w);
    }
  }
  const fillers = [
    'i',
    'me',
    'mujhe',
    'mujhko',
    'मुझे',
    'मुझको',
    'to',
    'please',
    'कृपया',
    'कोई',
    'some',
    'a',
    'थोड़ा',
    'little',
    'want',
    'चाहिए',
  ];
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t && !fillers.includes(t.toLowerCase()))
    .map((t) => t.replace(/\b\d+\s?(kg|g|ltr|ml|litre|packet|pack|पैकेट)?\b/gi, '').trim())
    .filter(Boolean);
  const item = tokens
    .join(' ')
    .replace(/[,.;].*$/, '')
    .trim();
  // Generic grocery words with no specific item → ask "what do you need?".
  const generic = [
    'grocery',
    'groceries',
    'kirana',
    'सामान',
    'किराना',
    'कुछ',
    'something',
    'stuff',
    'items',
    'things',
    'सब्ज़ी',
  ];
  if (!item || generic.includes(item.toLowerCase())) return '';
  return item;
}

function extractQuantity(text: string): string | null {
  const m = text.match(/(\d+\s?(?:kg|g|ltr|ml|litre|packet|pack|पैकेट))/i);
  return m ? (m[1] ?? '').replace(/\s+/g, ' ').trim() || null : null;
}

function extractMealName(raw: string): string | null {
  // crude: text after "to" / "से" / "with"
  const m = raw.match(/(?:to|से|with|रख)\s+(.+)/i);
  return m ? (m[1] ?? '').split(/[,.;]/)[0]?.trim() || null : null;
}

/**
 * Turn a grocery intent into the role-appropriate suggestion. A Cook creates a
 * Grocery Request; a Member is offered "Add to Suggested Cart" (issue 06, AC#4).
 */
export function roleForGroceryIntent(
  role: 'owner' | 'member' | 'cook',
): 'grocery_request' | 'add_to_cart' {
  return role === 'cook' ? 'grocery_request' : 'add_to_cart';
}
