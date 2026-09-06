/**
 * What gets *said*, as opposed to what gets *shown*.
 *
 * These are two different strings and were being treated as one. A reply
 * containing "**Heads up:**" was spoken as "asterisk asterisk heads up asterisk
 * asterisk", and a Sources block was read out as three full URLs, character by
 * character, including "h-t-t-p-s colon slash slash".
 *
 * Every real voice assistant keeps two channels for one turn: the screen gets
 * the complete answer with its links and formatting, and the speaker gets a
 * rendering meant for ears. The transcript here still receives everything
 * verbatim — this only decides what reaches the synthesiser.
 *
 * Two rules shape it:
 *
 *   1. **Never say a thing that is only meaningful on a screen.** Markdown
 *      syntax, URLs, file paths, table pipes. Say where it is instead.
 *   2. **Say it once.** A pointer like "the link is in your transcript" is
 *      useful the first time and irritating the third, so each kind is
 *      announced at most once per reply.
 *
 * Streaming makes this harder than a one-pass regex: tokens arrive a few
 * characters at a time, so a fence can be split across two deltas and a
 * "Sources:" heading can arrive as "Sour" then "ces:". The filter is therefore
 * a small state machine that holds back anything it cannot yet classify.
 */

/** Things worth announcing once, in the words the ear should hear. */
const NOTICES = {
  code: "I've put the code in your transcript.",
  link: "I've put the link in your transcript.",
  links: "I've put the links in your transcript.",
  sources: "I've listed the sources in your transcript.",
  table: "There's a table in your transcript.",
};

const FENCE = /^\s*```/;
const SOURCES_HEADING = /^\s*(?:\*\*)?(?:sources?|references?|citations?|links?)\s*:?\s*(?:\*\*)?\s*$/i;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const BARE_URL = /\bhttps?:\/\/\S+/gi;
const MD_LINK = /\[([^\]]*)\]\(([^)]*)\)/g;
// Absolute paths, either flavour. Spoken as a filename or not at all.
const ABS_PATH = /(?:[A-Za-z]:)?[\\/][\w.@$%~+-]+(?:[\\/][\w.@$%~+-]+)+/g;

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

function threeDigitsToWords(n) {
  const parts = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) parts.push(`${ONES[hundreds]} hundred`);
  if (rest) {
    if (rest < 20) parts.push(ONES[rest]);
    else {
      const tens = Math.floor(rest / 10);
      const ones = rest % 10;
      parts.push(ones ? `${TENS[tens]}-${ONES[ones]}` : TENS[tens]);
    }
  }
  return parts.join(' ');
}

function numberToWords(n) {
  if (n === 0) return 'zero';
  const groups = [];
  let rest = n;
  let scale = 0;
  while (rest > 0) {
    const group = rest % 1000;
    if (group) groups.unshift(`${threeDigitsToWords(group)}${SCALES[scale] ? ` ${SCALES[scale]}` : ''}`);
    rest = Math.floor(rest / 1000);
    scale += 1;
  }
  return groups.join(' ');
}

/*
 * "$1" read in symbol order comes out as "dollar one"; said aloud it's "one
 * dollar". A trailing scale word changes what the decimal point means:
 * "$252.8 million" is two hundred fifty-two POINT EIGHT million, not 252
 * dollars and 80 cents followed by a dangling "million".
 *
 * The amount is also singular when it is modifying a noun — "a five million
 * DOLLAR grant", not "a five million DOLLARS grant" — and that is the reason
 * for the two extra groups. English marks this by position rather than by any
 * word in the phrase itself, so it has to be read off the surroundings:
 *
 *   a $5 million grant   -> determiner, then a noun   -> attributive, singular
 *   the $10 bill         -> determiner, then a noun   -> attributive, singular
 *   the $10 was missing  -> determiner, then a verb   -> plural
 *   it costs $10         -> no determiner             -> plural
 *
 * A determiner immediately before the amount is the giveaway: it belongs to a
 * noun further along, not to the money. Requiring both halves keeps this narrow
 * — anything it cannot recognise falls through to the plural, which is what it
 * always used to say.
 */
const DETERMINER = String.raw`\b(?:an?|the|this|that|each|every|another|per)\s+`;
const CURRENCY = new RegExp(
  String.raw`(${DETERMINER})?`                                  // 1 determiner
  + String.raw`\$(\d{1,3}(?:,\d{3})*|\d+)(\.\d+)?`              // 2 whole, 3 cents
  + String.raw`(?:\s(thousand|million|billion|trillion))?`      // 4 scale
  + String.raw`(?=(?:\s+([A-Za-z][A-Za-z-]*))?)`,               // 5 the next word
  'gi');

/*
 * Words that, following an amount, mean it is not modifying a noun.
 *
 * "the $10 is missing" has a determiner and a following word, but the word is a
 * verb and the amount is the subject, so it stays plural. Verbs, prepositions
 * and conjunctions cover the realistic ways a sentence continues after a sum of
 * money that is not being used as an adjective.
 */
const NOT_A_NOUN = new RegExp(`^(?:${[
  'is', 'was', 'are', 'were', 'be', 'been', 'being',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must',
  'has', 'have', 'had', 'do', 'does', 'did',
  'went', 'goes', 'came', 'comes', 'seems', 'looks', 'costs', 'buys',
  'includes', 'remains', 'rose', 'fell', 'jumped', 'dropped', 'covers',
  'in', 'on', 'of', 'for', 'to', 'from', 'at', 'by', 'with', 'into', 'onto',
  'over', 'under', 'about', 'across', 'per', 'than', 'plus', 'minus', 'versus',
  'and', 'or', 'but', 'so', 'if', 'then', 'that', 'which', 'while',
  'now', 'today', 'already', 'still', 'just', 'only', 'also', 'each',
].join('|')})$`, 'i');

/**
 * Is the word after the amount a noun the amount could be describing?
 *
 * Past participles are the gap the word list cannot cover, because there are
 * too many of them: "per $100 invested" read as "per one hundred dollar
 * invested". A trailing "-ed" is a reliable enough sign of one, provided short
 * words are spared — "feed", "shed" and "seed" are perfectly good nouns.
 *
 * "-ing" is deliberately *not* excluded. In this position it is usually part of
 * the noun phrase rather than a verb: "a $5 shipping fee", "a $2 billion
 * funding round".
 */
function looksLikeNoun(word) {
  if (!word || NOT_A_NOUN.test(word)) return false;
  return !(word.length > 4 && /ed$/i.test(word));
}

/** A number as it appears in prose: grouped by commas, optionally decimal. */
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?`;

/*
 * A price range, handled before anything else touches the dashes.
 *
 * Asking for the price of bitcoin produced "$79,600–81,200", and it came out of
 * the speaker as "seventy-nine thousand six hundred dollars, eighty-one
 * thousand two hundred" — two separate amounts with a comma between them, which
 * is not what the sentence means. Two rules were fighting: the currency rule
 * only matched the half with the dollar sign on it, and the dash rule then
 * turned the range into a pause.
 *
 * A range is the single most likely shape for a price, so it is worth matching
 * as one thing. Requiring a `$` on the left keeps ordinary hyphenated text and
 * date ranges out of it.
 */
const CURRENCY_RANGE = new RegExp(
  String.raw`(${DETERMINER})?`                                  // 1 determiner
  + String.raw`\$(${AMOUNT})\s*[–—-]\s*\$?(${AMOUNT})`         // 2 low, 3 high
  + String.raw`(?:\s(thousand|million|billion|trillion))?`      // 4 scale
  + String.raw`(?=(?:\s+([A-Za-z][A-Za-z-]*))?)`,               // 5 the next word
  'gi');

/** "1,250" -> "one thousand two hundred fifty"; "1.5" -> "one point five". */
function amountToWords(text) {
  const [whole, frac] = text.replace(/,/g, '').split('.');
  let words = numberToWords(parseInt(whole, 10));
  if (frac) words += ` point ${frac.split('').map((d) => ONES[Number(d)]).join(' ')}`;
  return words;
}

function currencyRangeToWords(_m, determiner, low, high, scale, nextWord) {
  const unit = scale ? ` ${scale.toLowerCase()}` : '';
  // A range modifies a noun just as a single amount does: "the seventy-nine
  // thousand to eighty thousand DOLLAR range".
  const singular = Boolean(determiner) && looksLikeNoun(nextWord);
  return `${determiner ?? ''}${amountToWords(low)} to ${amountToWords(high)}${unit}`
    + ` ${singular ? 'dollar' : 'dollars'}`;
}

/*
 * Abbreviations a synthesiser spells out letter by letter.
 *
 * "e.g." was read aloud as "E. G.", which is not a thing anyone says. These are
 * common in written answers and each one is a small jolt in a spoken one.
 */
const SAY_AS = [
  // The trailing comma is swallowed deliberately: "e.g., X" would otherwise
  // become "for example, , X" and be read with two beats.
  [/\be\.g\.,?\s*/gi, 'for example, '],
  [/\bi\.e\.,?\s*/gi, 'that is, '],
  [/\bvs\.?\s/gi, 'versus '],
  [/\bapprox\.\s*/gi, 'approximately '],
];

function currencyToWords(_m, determiner, whole, frac, scale, nextWord) {
  const wholeNum = parseInt(whole.replace(/,/g, ''), 10);
  const lead = determiner ?? '';
  /*
   * Modifying a noun, so the unit is singular.
   *
   * Cents are excluded on purpose: "a $1.50 coffee" has no natural spoken form
   * with a singular unit, and guessing at one would be worse than the plural.
   */
  const modifiesNoun = Boolean(determiner) && looksLikeNoun(nextWord);
  // Cents are excluded from the dollar case on purpose: "a $1.50 coffee" has no
  // natural spoken form with a singular unit. A sub-dollar amount is different
  // - "the five cent fee" is exactly how that is said - and is handled below.
  const attributive = modifiesNoun && !frac;
  const unit = (attributive || wholeNum === 1) ? 'dollar' : 'dollars';

  if (scale) {
    let words = numberToWords(wholeNum);
    if (frac) {
      const digitWords = frac.slice(1).split('').map((d) => ONES[Number(d)]).join(' ');
      words += ` point ${digitWords}`;
    }
    /*
     * `modifiesNoun`, not `attributive`. The cents guard the latter carries is
     * meaningless here: in "$1.5 trillion" the decimal is part of the number,
     * not a number of cents, so it says nothing about the unit. Using the
     * stricter flag made "the $1.5 trillion market-cap level" plural again.
     */
    return `${lead}${words} ${scale.toLowerCase()} ${modifiesNoun ? 'dollar' : 'dollars'}`;
  }
  const dollarWords = `${lead}${numberToWords(wholeNum)} ${unit}`;
  if (!frac) return dollarWords;
  const digits = frac.slice(1);
  /*
   * Only one or two decimal places are cents.
   *
   * A spot price carries more: Coinbase returned $79,676.245, and treating the
   * tail as cents said "two hundred forty-five cents" — which is both wrong and
   * impossible. Beyond two places the digits are read out as digits, which is
   * how a person says an unusually precise number and does not quietly discard
   * any of it.
   */
  // `lead` is put back on every path below. It was captured out of the source
  // text, so dropping it on any branch silently deletes the word before the
  // amount — "the $0.05 fee" would lose its "the".
  if (digits.length > 2) {
    const spoken = digits.split('').map((d) => ONES[Number(d)]).join(' ');
    return `${lead}${numberToWords(wholeNum)} point ${spoken} dollars`;
  }
  let centsNum = parseInt(digits, 10);
  if (digits.length === 1) centsNum *= 10; // ".5" is 50 cents, not 5
  if (centsNum === 0) return dollarWords;
  // "the $0.05 fee" is "the five cent fee", singular, for the same reason a
  // whole-dollar amount is.
  const centsAttributive = modifiesNoun && wholeNum === 0;
  const centWords = `${numberToWords(centsNum)} cent${(centsNum === 1 || centsAttributive) ? '' : 's'}`;
  return wholeNum === 0 ? `${lead}${centWords}` : `${dollarWords} and ${centWords}`;
}

/**
 * A streaming markdown-to-speech filter.
 *
 * `feed(delta)` returns whatever is now safe to say — possibly nothing, if the
 * filter is mid-fence or waiting to see whether a line is a heading.
 * `flush()` returns what is left when the turn ends.
 */
export function makeSpeechFilter() {
  let pending = '';        // text held back until the line it is on is complete
  let inCode = false;
  let inSources = false;
  const said = new Set();  // notices already given this turn

  const notice = (kind) => {
    // Singular and plural are the same announcement as far as repetition goes.
    // Keyed separately, a reply with three links on one line and one on the
    // next said it twice — "links in your transcript… link in your transcript".
    const key = kind === 'links' ? 'link' : kind;
    if (said.has(key)) return '';
    said.add(key);
    return `${NOTICES[kind]} `;
  };

  /** Inline cleanup, applied to a line that is definitely going to be spoken. */
  function inline(text) {
    let out = text;
    let linkCount = 0;
    let cutCode = false;

    // Markdown links become their label. The label is the readable part; the
    // URL never is.
    out = out.replace(MD_LINK, (_m, label) => {
      linkCount += 1;
      return String(label).trim();
    });
    // Bare URLs have no label to fall back on, so they are replaced entirely.
    out = out.replace(BARE_URL, () => {
      linkCount += 1;
      return '';
    });
    // A path read aloud is a stream of letters and slashes; the filename is
    // the only part anyone wants to hear.
    out = out.replace(ABS_PATH, (m) => m.split(/[\\/]/).filter(Boolean).pop() || 'a file');
    // Ranges first: the plain currency rule would take only the half carrying
    // the dollar sign, and the dash rule would then split the range in two.
    out = out.replace(CURRENCY_RANGE, currencyRangeToWords);
    out = out.replace(CURRENCY, currencyToWords);
    for (const [pattern, say] of SAY_AS) out = out.replace(pattern, say);

    out = out
      /*
       * Inline code: keep it only if it is a word.
       *
       * Stripping the backticks and keeping the contents meant hearing
       * "str dot split open paren quote quote close paren" and
       * "bracket quote t quote comma quote a quote". A bare identifier like
       * `reverse` reads fine aloud; anything with brackets, quotes or an
       * operator in it does not, and the sentence around it almost always
       * survives its removal.
       */
      .replace(/`{1,3}([^`]*)`{1,3}/g, (_m, code) => {
        if (!/[()[\]{}<>='"|;]/.test(code) && code.length <= 24) return code;
        cutCode = true;
        return '';
      })
      .replace(/\*\*([^*]*)\*\*/g, '$1')       // bold
      .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2') // italic
      .replace(/(^|\s)_([^_\n]+)_/g, '$1$2')   // underscore italic
      .replace(/^#{1,6}\s*/, '')               // heading marks
      .replace(/^\s*[-*+]\s+/, '')             // bullet marks
      .replace(/^\s*\d+[.)]\s+/, '')           // numbered list marks
      .replace(/^\s*>\s?/, '')                 // block quote
      // The surrounding space goes with it, or "now — a milestone" becomes
      // "now , a milestone" with a stray gap before the comma.
      .replace(/\s*[—–]\s*/g, ', ')  // dashes become a spoken pause
      .replace(/[“”‘’]/g, (c) => (/[‘’]/.test(c) ? "'" : ''))
      // Emoji and pictographs have no pronunciation worth hearing.
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
      /*
       * The catch-all, and it is not redundant.
       *
       * Every rule above needs both halves of a pair on the same line, and a
       * long line gets released early — mid-sentence — so a `**bold**` can be
       * split across two calls leaving one marker orphaned. That reached the
       * synthesiser and was read aloud as "asterisk". No rule above is allowed
       * to be the last line of defence; this is.
       */
      .replace(/[*`|#~]/g, '')
      .replace(/_+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    /*
     * A sentence whose subject was the code is not worth saying without it.
     *
     * Dropping the spans alone produced "How it works: , splits the string
     * into an array. becomes . , reverses the order" — each line was a
     * fragment hanging off a symbol that is no longer there. If code was
     * removed and too little prose is left to stand on its own, the whole line
     * goes; the transcript still has all of it.
     */
    if (cutCode) {
      out = out.replace(/^[\s,;:.\-–—]+/, '').trim();
      const words = out.split(/\s+/).filter(Boolean);
      if (words.length < 4) return '';
    }

    if (linkCount) out = notice(linkCount > 1 ? 'links' : 'link') + out;
    return out;
  }

  /** Decide what a completed line contributes to speech. */
  function line(raw) {
    if (FENCE.test(raw)) {
      inCode = !inCode;
      return inCode ? notice('code') : '';
    }
    if (inCode) return '';                       // never read code aloud

    if (SOURCES_HEADING.test(raw)) {
      // Everything after a Sources heading is citations; the whole tail goes.
      inSources = true;
      return notice('sources');
    }
    if (inSources) return '';

    if (TABLE_ROW.test(raw)) return notice('table');

    const spoken = inline(raw);
    if (!spoken) return '';
    // A bullet that has lost its dash still needs to end somewhere, or the
    // synthesiser runs three list items into one breathless sentence.
    return /[.!?,;:]$/.test(spoken) ? `${spoken} ` : `${spoken}. `;
  }

  return {
    feed(text) {
      pending += text;
      let out = '';
      for (;;) {
        const at = pending.indexOf('\n');
        if (at < 0) break;
        out += line(pending.slice(0, at));
        pending = pending.slice(at + 1);
      }
      /*
       * A line with no newline yet cannot be classified — it might still turn
       * out to be a fence or a Sources heading. But holding everything until a
       * newline would stall a one-line answer completely, so a line that is
       * already long and clearly prose is released early.
       */
      if (pending.length > 80 && !FENCE.test(pending) && !inCode && !inSources
        && !/^\s*(?:\*\*)?(?:s|r|c|l)/i.test(pending)) {
        const cut = pending.lastIndexOf(' ');
        if (cut > 40) {
          const part = inline(pending.slice(0, cut));
          if (part) out += part + ' ';
          pending = pending.slice(cut + 1);
        }
      }
      return out;
    },

    flush() {
      const rest = pending;
      pending = '';
      const out = rest.trim() ? line(rest) : '';
      inCode = false;
      inSources = false;
      said.clear();
      return out;
    },
  };
}

/** One-shot version, for text that is already complete. */
export function speakable(text) {
  const filter = makeSpeechFilter();
  return `${filter.feed(`${text}\n`)}${filter.flush()}`.replace(/\s{2,}/g, ' ').trim();
}
