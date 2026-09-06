import assert from 'node:assert/strict';
import test from 'node:test';

import { speakable, makeSpeechFilter } from '../server/speech-text.mjs';

/**
 * The fixture is the real reply that prompted this, photographed off a phone:
 * asterisks read aloud as "asterisk asterisk", then three full URLs spelled
 * out character by character.
 */
const REAL_REPLY = [
  '**Heads up:** A High Surf Advisory is in effect until 6am Sept 5, and windy',
  'conditions are expected through Friday due to a pressure gradient from',
  'Hurricane Lowell.',
  '',
  'Sources:',
  '- [Zone Area Forecast for Kona](https://forecast.weather.gov/MapClick.php?zoneid=HIZ023)',
  '- [Hawaii County Weather Forecast | Big Island Now](https://bigislandnow.com/2026/09/03/x/)',
  '- [Kailua Kona, HI Weather | AccuWeather](https://www.accuweather.com/en/us/kailua/96740/)',
].join('\n');

test('never says a URL out loud', () => {
  const out = speakable(REAL_REPLY);
  assert.ok(!/https?:/i.test(out), `a URL survived: ${out}`);
  assert.ok(!out.includes('://'), `a scheme survived: ${out}`);
  assert.ok(!/weather\.gov|accuweather\.com/i.test(out), `a domain survived: ${out}`);
});

test('never says markdown punctuation out loud', () => {
  const out = speakable(REAL_REPLY);
  for (const junk of ['**', '](', '](http', '`', '##']) {
    assert.ok(!out.includes(junk), `"${junk}" survived: ${out}`);
  }
  assert.match(out, /Heads up/, 'the actual words should survive');
});

test('drops the sources block and says where it went', () => {
  const out = speakable(REAL_REPLY);
  assert.ok(!/Zone Area Forecast|Big Island Now|AccuWeather/i.test(out),
    `a citation was read aloud: ${out}`);
  assert.match(out, /transcript/i, 'it should say where the sources are');
  assert.match(out, /High Surf Advisory/, 'the answer itself must survive');
});

test('never reads code aloud', () => {
  const out = speakable([
    'Here is the fix.',
    '```js',
    'const x = arr.filter(Boolean).map((n) => n * 2);',
    'export default x;',
    '```',
    'That should do it.',
  ].join('\n'));
  assert.ok(!/const x|=>|export default/.test(out), `code was spoken: ${out}`);
  assert.match(out, /Here is the fix/);
  assert.match(out, /That should do it/);
  assert.match(out, /code.*transcript/i, 'it should say the code is in the transcript');
});

test('says the pointer once, not once per link', () => {
  const out = speakable([
    'Check [one](https://a.com), [two](https://b.com) and [three](https://c.com).',
    'Also see [four](https://d.com).',
  ].join('\n'));
  const mentions = (out.match(/in your transcript/gi) ?? []).length;
  assert.equal(mentions, 1, `said it ${mentions} times: ${out}`);
});

test('keeps the readable label of a link', () => {
  const out = speakable('See the [Tailscale docs](https://tailscale.com/kb) for details.');
  assert.match(out, /Tailscale docs/);
  assert.ok(!/tailscale\.com/.test(out));
});

test('turns a file path into a filename', () => {
  const out = speakable('I updated C:\\Users\\redfoo\\project\\src\\main.js just now.');
  assert.ok(!out.includes('\\'), `a path was spelled out: ${out}`);
  assert.match(out, /main\.js/);
});

test('reads a bullet list as sentences, not as dashes', () => {
  const out = speakable(['Three things:', '- first item', '- second item', '- third item'].join('\n'));
  assert.ok(!/^\s*-/m.test(out), `a dash survived: ${out}`);
  assert.match(out, /first item/);
  // Each item needs to end somewhere or they run together breathlessly.
  assert.match(out, /first item\.\s*second item/i);
});

test('does not read a table', () => {
  const out = speakable(['Results:', '| a | b |', '| - | - |', '| 1 | 2 |'].join('\n'));
  assert.ok(!out.includes('|'), `a pipe survived: ${out}`);
  assert.match(out, /table.*transcript/i);
});

test('drops emoji', () => {
  const out = speakable('All good ✅ and shipping 🚀 now.');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(out), `emoji survived: ${out}`);
  assert.match(out, /All good/);
});

test('streams: a fence split across deltas still suppresses the code', () => {
  // Tokens arrive a few characters at a time; a fence is regularly cut in half.
  const source = 'Fixing it now.\n```py\nprint("secret")\n```\nDone.\n';
  for (const size of [1, 2, 3, 5, 7, 13, 40]) {
    const filter = makeSpeechFilter();
    let out = '';
    for (let i = 0; i < source.length; i += size) out += filter.feed(source.slice(i, i + size));
    out += filter.flush();
    assert.ok(!/print|secret/.test(out), `code leaked at delta size ${size}: ${out}`);
    assert.match(out, /Fixing it now/);
    assert.match(out, /Done/);
  }
});

test('streams: a Sources heading split across deltas still suppresses citations', () => {
  const source = `${REAL_REPLY}\n`;
  for (const size of [1, 4, 9, 25]) {
    const filter = makeSpeechFilter();
    let out = '';
    for (let i = 0; i < source.length; i += size) out += filter.feed(source.slice(i, i + size));
    out += filter.flush();
    assert.ok(!/https?:|AccuWeather/i.test(out), `citations leaked at delta size ${size}: ${out}`);
  }
});

test('plain prose passes through essentially untouched', () => {
  const plain = 'Tokyo is the capital of Japan. It is known for its food and its trains.';
  const out = speakable(plain);
  assert.equal(out, plain, `plain speech was altered: ${out}`);
});

test('a short one-line answer is not swallowed', () => {
  assert.match(speakable('Yes.'), /Yes/);
  assert.match(speakable('About four seconds.'), /four seconds/);
});

test('no markdown punctuation ever survives, at any delta size', () => {
  // The catch-all. Paired rules need both halves on one line, and a long line
  // is released early, so a bold marker can be split and orphaned — that
  // reached the synthesiser and was read aloud as "asterisk".
  const messy = [
    '**Heads up:** the *surf* is `high` and there is a ~~strike~~ warning.',
    'A very long line of prose that will certainly exceed the early release threshold and be cut somewhere in the **middle of a bold run** before the closing marker arrives.',
    '## A heading',
    '| a | b |',
  ].join('\n') + '\n';

  for (const size of [1, 2, 3, 7, 17, 60]) {
    const filter = makeSpeechFilter();
    let out = '';
    for (let i = 0; i < messy.length; i += size) out += filter.feed(messy.slice(i, i + size));
    out += filter.flush();
    for (const ch of ['*', '`', '|', '#', '~']) {
      assert.ok(!out.includes(ch), `"${ch}" reached speech at delta size ${size}: ${out}`);
    }
  }
});

test('sentences never butt together without a space', () => {
  const out = speakable('Here is Kona, Hawaii.\nLet me check the forecast.');
  assert.ok(!/[a-z]\.[A-Z]/.test(out), `sentences ran together: ${out}`);
});

test('an amount describing a noun is singular', () => {
  // "A $5 million grant" was spoken as "a five million DOLLARS grant". English
  // uses the singular when the amount modifies a noun, and marks it by position
  // rather than by any word inside the phrase.
  assert.equal(speakable('A $5 million grant.'), 'A five million dollar grant.');
  assert.equal(speakable('The $10 bill was folded.'), 'The ten dollar bill was folded.');
  assert.equal(speakable('That is the $64,000 question.'),
    'That is the sixty-four thousand dollar question.');
  assert.equal(speakable('A $2 billion funding round.'), 'A two billion dollar funding round.');
  assert.equal(speakable('The $0.05 fee applies.'), 'The five cent fee applies.');
});

test('an amount that is the subject stays plural', () => {
  // The other half of the rule, and the reason it has to look at both sides: a
  // determiner alone is not enough, or "the $10 was missing" turns singular.
  assert.equal(speakable('The $10 was missing.'), 'The ten dollars was missing.');
  assert.equal(speakable('The $10 in my pocket.'), 'The ten dollars in my pocket.');
  assert.equal(speakable('It costs $10.'), 'It costs ten dollars.');
  assert.equal(speakable('Revenue was $1.2 million last year.'),
    'Revenue was one point two million dollars last year.');
  // A past participle is not a noun, and there are too many to list by name.
  assert.equal(speakable('Per $100 invested.'), 'Per one hundred dollars invested.');
  assert.equal(speakable('Every $1 spent earns a point.'), 'Every one dollar spent earns a point.');
});

test('the word before the amount is never swallowed', () => {
  // The determiner is captured by the pattern, so every branch has to put it
  // back. Miss one and the word before the money silently disappears.
  for (const [input, expected] of [
    ['The $0.05 fee applies.', /^The five cent fee/],
    ['A $1.50 coffee.', /^A one dollar and fifty cents/],
    ['The $79,676.245 price.', /^The seventy-nine thousand/],
    ['A $5 shipping fee.', /^A five dollar shipping fee/],
  ]) {
    assert.match(speakable(input), expected, `lost the leading word in: ${input}`);
  }
});

test('reads a price range as a range, not as two prices', () => {
  /*
   * Asking for the price of bitcoin produced "$79,600–81,200" and it was spoken
   * as "seventy-nine thousand six hundred dollars, eighty-one thousand two
   * hundred" — two amounts with a pause between them, which is not what the
   * sentence says. The currency rule matched only the half with the dollar sign
   * and the dash rule then broke the range in two.
   */
  assert.equal(speakable('Bitcoin is around $79,600–81,200 today.'),
    'Bitcoin is around seventy-nine thousand six hundred to eighty-one thousand two hundred dollars today.');
  assert.equal(speakable('Around $79,500–$80,900 depending on the exchange.'),
    'Around seventy-nine thousand five hundred to eighty thousand nine hundred dollars depending on the exchange.');
  assert.equal(speakable('Inflows of $1.2–2.5 billion.'),
    'Inflows of one point two to two point five billion dollars.');
  assert.equal(speakable('The range is $5-10.'), 'The range is five to ten dollars.');
});

test('a range describing a noun is singular too', () => {
  // Found by asking the live server for a price: "the $79,000–$80,000 range"
  // was spoken as "... to eighty thousand DOLLARS range".
  assert.equal(speakable('Trading in the $79,000–$80,000 range right now.'),
    'Trading in the seventy-nine thousand to eighty thousand dollar range right now.');
  // And a scale word with a decimal: the ".5" here is part of the number, not
  // cents, so it must not suppress the singular.
  assert.equal(speakable('Holding above the $1.5 trillion market-cap level.'),
    'Holding above the one point five trillion dollar market-cap level.');
  // Still plural when it is not modifying anything.
  assert.match(speakable('Bitcoin is around $79,600–81,200 today.'), /two hundred dollars today/);
});

test('a dash does not leave a gap before the comma it becomes', () => {
  // "It cost $10 — a bargain." was rendered "ten dollars , a bargain".
  assert.equal(speakable('It cost $10 — a bargain.'), 'It cost ten dollars, a bargain.');
  assert.ok(!/\s,/.test(speakable('Now — a milestone — again.')));
});

test('a range needs a currency sign, so ordinary hyphens are left alone', () => {
  // The hyphen form is only safe because a `$` is required on the left. Without
  // that guard these would all be mangled into spoken ranges.
  for (const plain of ['It is 2026-2027 now.', 'A well-known trade-off applies.',
    'See pages 10-12 for details.']) {
    assert.equal(speakable(plain), plain, `a plain hyphen was rewritten: ${plain}`);
  }
});

test('more than two decimal places are not cents', () => {
  // Coinbase returns $79,676.245 for a spot price. Read as cents that became
  // "two hundred forty-five cents", which is both wrong and impossible.
  const out = speakable('Bitcoin is at $79,676.245 right now.');
  assert.ok(!/cents/.test(out), `sub-cent digits were read as cents: ${out}`);
  assert.match(out, /point two four five dollars/);
  // And the ordinary cases still behave.
  assert.equal(speakable('It costs $1.50.'), 'It costs one dollar and fifty cents.');
  assert.equal(speakable('It costs $2.5.'), 'It costs two dollars and fifty cents.');
});

test('abbreviations are said, not spelled out', () => {
  // "e.g." came out of the speaker as "E. G.".
  assert.equal(speakable('Some exchanges (e.g., CoinGecko) disagree.'),
    'Some exchanges (for example, CoinGecko) disagree.');
  assert.match(speakable('It is fast, i.e. under a second.'), /that is, under a second/);
  assert.ok(!/e\.g\.|i\.e\./.test(speakable('Use e.g. this, i.e. that.')));
});

test('a price range survives being split across deltas', () => {
  const source = 'Bitcoin is around $79,600–81,200 today.\n';
  for (const size of [1, 2, 3, 5, 9, 30]) {
    const filter = makeSpeechFilter();
    let out = '';
    for (let i = 0; i < source.length; i += size) out += filter.feed(source.slice(i, i + size));
    out += filter.flush();
    assert.match(out, /six hundred to eighty-one thousand/,
      `the range broke at delta size ${size}: ${out}`);
    assert.ok(!/\$/.test(out), `a dollar sign reached speech at delta size ${size}: ${out}`);
  }
});

test('reads a dollar amount as words, not symbol-then-number', () => {
  assert.equal(speakable('It costs $1.'), 'It costs one dollar.');
  assert.equal(speakable('It costs $10.'), 'It costs ten dollars.');
  assert.equal(speakable('It costs $1,250.'), 'It costs one thousand two hundred fifty dollars.');
  assert.equal(speakable('It costs $1.50.'), 'It costs one dollar and fifty cents.');
  assert.equal(speakable('It costs $0.05.'), 'It costs five cents.');
});

test('a scale word after the amount changes what the decimal means', () => {
  // "$252.8 million" is 252.8 million, not 252 dollars and 80 cents with a
  // dangling "million" left over.
  assert.equal(speakable('Inflows of $252.8 million.'), 'Inflows of two hundred fifty-two point eight million dollars.');
  // Singular here because it modifies "grant". This assertion used to expect
  // "dollars grant", which is what it actually said and was the bug.
  assert.equal(speakable('A $5 million grant.'), 'A five million dollar grant.');
});

test('inline code is spoken only when it is a pronounceable word', () => {
  // "str.split('')" was spoken as "str dot split open paren quote quote close
  // paren", and "['t','a','c']" as a stream of punctuation.
  const out = speakable("Use `reverse` after `str.split('')` to get `['t','a','c']` back.");
  assert.match(out, /reverse/, 'a bare identifier is fine to say');
  assert.ok(!out.includes('split('), `a call expression was spoken: ${out}`);
  assert.ok(!out.includes('['), `an array literal was spoken: ${out}`);
  assert.ok(!out.includes("'"), `quote characters were spoken: ${out}`);
});

test('a line left as a fragment by code removal is dropped, not mumbled', () => {
  // Real output before this rule: "How it works: , splits the string into an
  // array. becomes . , reverses the order of elements".
  const out = speakable([
    'How it works:',
    "- `str.split('')` — splits the string into characters",
    "- `['c','a','t']` becomes `['t','a','c']`",
    '- `.join("")` glues it back together',
  ].join('\n'));
  assert.ok(!/^\s*[,.]/m.test(out), `a line starts with punctuation: ${out}`);
  assert.ok(!/\bbecomes\s*\.?\s*$/m.test(out), `a stranded fragment survived: ${out}`);
  // The line with enough prose of its own is still worth saying.
  assert.match(out, /splits the string into characters/);
});
