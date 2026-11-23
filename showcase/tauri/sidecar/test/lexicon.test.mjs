// Transcript name fixing: buildLexicon indexes the user's list, fixNames repairs misheard words. Run: npm test
import assert from 'node:assert/strict';
import { buildLexicon, fixNames, phoneticKey } from '../lexicon.mjs';

const fix = (text, names, options) => fixNames(text, buildLexicon(names), options);
const one = (text, name, options) => fix(text, [name], options);

// Sound keys: vowels and doubled sounds go, similar consonants share a letter.
assert.equal(phoneticKey('Mira'), 'mr');
assert.equal(phoneticKey('Korbett'), 'krpt');
assert.equal(phoneticKey('GraphQL'), 'krfkl');
assert.equal(phoneticKey('cooper netties'), 'kprnts');
for (const junk of [null, undefined, 42, {}, '', '123', '!!!']) assert.equal(phoneticKey(junk), '');

// Building ignores blanks, duplicates (case-insensitively) and entries longer than three words.
assert.equal(buildLexicon(null).entries.length, 0);
assert.equal(buildLexicon([42, {}, null]).entries.length, 0);
assert.equal(buildLexicon(['Mira', '', '   ', 'mira', 'MIRA', 'one two three four']).entries.length, 1);
assert.equal(buildLexicon(['Mira Voss', 'Dr. Vell', 'GraphQL']).entries.length, 3);

// One misheard word, with the original offset and substring reported.
assert.deepEqual(one('meera spoke', 'Mira'), {
  text: 'Mira spoke', changes: [{ from: 'meera', to: 'Mira', at: 0 }],
});
assert.deepEqual(one('I met meera today', 'Mira').changes, [{ from: 'meera', to: 'Mira', at: 6 }]);
// Correct text is left alone.
assert.deepEqual(one('Mira spoke', 'Mira'), { text: 'Mira spoke', changes: [] });

// Two-word names, including a one-more-word window.
assert.deepEqual(one('meera vahs joined', 'Mira Voss'), {
  text: 'Mira Voss joined', changes: [{ from: 'meera vahs', to: 'Mira Voss', at: 0 }],
});
assert.deepEqual(one('the korbetts came', 'Mira Voss'), { text: 'the korbetts came', changes: [] });

// A two-word window fixes a one-word entry; a one-word window fixes a two-word entry.
assert.deepEqual(one('cor bet arrived', 'Korbett'), {
  text: 'Korbett arrived', changes: [{ from: 'cor bet', to: 'Korbett', at: 0 }],
});
assert.deepEqual(one('cooper netties is hard', 'Kubernetes'), {
  text: 'Kubernetes is hard', changes: [{ from: 'cooper netties', to: 'Kubernetes', at: 0 }],
});
assert.deepEqual(one('we hired meeravoss', 'Mira Voss'), {
  text: 'we hired Mira Voss', changes: [{ from: 'meeravoss', to: 'Mira Voss', at: 9 }],
});

// Exact spelling ignoring case only changes the casing, even across a whole name.
assert.deepEqual(one('quillbeam is ready', 'Quillbeam'), {
  text: 'Quillbeam is ready', changes: [{ from: 'quillbeam', to: 'Quillbeam', at: 0 }],
});
assert.deepEqual(one('we use graphql daily', 'GraphQL'), {
  text: 'we use GraphQL daily', changes: [{ from: 'graphql', to: 'GraphQL', at: 7 }],
});
assert.deepEqual(one('mira voss called', 'Mira Voss'), {
  text: 'Mira Voss called', changes: [{ from: 'mira voss', to: 'Mira Voss', at: 0 }],
});
assert.deepEqual(one('dr vell called', 'Dr. Vell'), {
  text: 'Dr. Vell called', changes: [{ from: 'dr vell', to: 'Dr. Vell', at: 0 }],
});

// Stoplist windows are protected unless the spelling is exact.
assert.deepEqual(one('to the store', 'Toh'), { text: 'to the store', changes: [] });
assert.deepEqual(one('we are here', 'Wahr'), { text: 'we are here', changes: [] });
// An everyday word keeps its case even when the list spells it the same way.
assert.deepEqual(one('i think so', 'I'), { text: 'i think so', changes: [] });

// Punctuation, spacing and possessives stay outside the replaced window.
assert.deepEqual(one('cor bet, arrived', 'Korbett'), {
  text: 'Korbett, arrived', changes: [{ from: 'cor bet', to: 'Korbett', at: 0 }],
});
assert.deepEqual(one('(meera)', 'Mira'), {
  text: '(Mira)', changes: [{ from: 'meera', to: 'Mira', at: 1 }],
});
assert.deepEqual(one("meera's hat", 'Mira'), {
  text: "Mira's hat", changes: [{ from: 'meera', to: 'Mira', at: 0 }],
});
assert.deepEqual(one('meera  spoke', 'Mira'), {
  text: 'Mira  spoke', changes: [{ from: 'meera', to: 'Mira', at: 0 }],
});

// Ordinary sentences with a lexicon nearby are not rewritten.
for (const names of [[], ['Mira Voss', 'Korbett', 'Quillbeam']]) {
  assert.deepEqual(fix('We should meet at the cafe and talk tomorrow.', names), {
    text: 'We should meet at the cafe and talk tomorrow.', changes: [],
  });
  assert.deepEqual(fix('The plan is to review the notes before dinner.', names), {
    text: 'The plan is to review the notes before dinner.', changes: [],
  });
}

// Several entries in one text: changes stay in original order with original offsets.
{
  const got = fix('meera and cor bet went to quillbeam.', ['Mira', 'Korbett', 'Quillbeam']);
  assert.equal(got.text, 'Mira and Korbett went to Quillbeam.');
  assert.deepEqual(got.changes, [
    { from: 'meera', to: 'Mira', at: 0 },
    { from: 'cor bet', to: 'Korbett', at: 10 },
    { from: 'quillbeam', to: 'Quillbeam', at: 26 },
  ]);
}

// Overlapping candidates: the better (longer, equally phonetic) match wins once.
{
  const got = fix('meera voss left', ['Mira', 'Mira Voss']);
  assert.equal(got.text, 'Mira Voss left');
  assert.equal(got.changes.length, 1);
}

// A higher threshold drops fuzzy matches, but exact casing fixes still happen.
assert.deepEqual(one('meera spoke', 'Mira', { minScore: 0.99 }), { text: 'meera spoke', changes: [] });
assert.deepEqual(one('mira spoke', 'Mira', { minScore: 0.99 }), {
  text: 'Mira spoke', changes: [{ from: 'mira', to: 'Mira', at: 0 }],
});

// Bad input never throws and returns the original text with no changes.
assert.deepEqual(fixNames(null, buildLexicon(['Mira'])), { text: '', changes: [] });
assert.deepEqual(fixNames(42, buildLexicon(['Mira'])), { text: '', changes: [] });
assert.deepEqual(fixNames('hello', null), { text: 'hello', changes: [] });
assert.deepEqual(fixNames('hello', ['Mira']), { text: 'hello', changes: [] });
assert.deepEqual(fixNames('hello', buildLexicon(['Mira']), null), { text: 'hello', changes: [] });
assert.deepEqual(one('  ... !!!  ', 'Mira'), { text: '  ... !!!  ', changes: [] });
assert.deepEqual(one('', 'Mira'), { text: '', changes: [] });

// Ten thousand words against five hundred entries stays well under a second.
{
  const code = (n) => { let s = ''; n++; while (n) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };
  const names = Array.from({ length: 500 }, (_, i) => `Vor${code(i)}ian`);
  const common = ('the a and we to of in for is that with on at it as but not so if do my your me him her our us ' +
    'they he she was are be this you or').split(' ');
  const words = Array.from({ length: 10000 }, (_, i) => (i % 11 === 0 ? 'vorblex' : common[i % common.length]));
  const started = process.hrtime.bigint();
  const result = fix(words.join(' '), names);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(typeof result.text, 'string');
  assert.ok(Array.isArray(result.changes));
  assert.ok(ms < 1000, `10k words x 500 entries took ${ms.toFixed(0)} ms`);
}

// Short names don't swallow everyday words that share their consonants, and a name that is also a word keeps
// the word's case.
const shorts = ['Ben', 'Sam', 'Ana', 'Will', 'Jira'];
for (const s of ['can you open a ticket for that', 'banana bread is great, same as last time', 'I will send it in a minute',
  'the bend in the road', 'we been there', 'some of them came back']) {
  assert.equal(fix(s, shorts).text, s, s);
}
assert.equal(fix('can you open a jeera ticket', shorts).text, 'can you open a Jira ticket');
assert.equal(fix('ask Will about it', shorts).text, 'ask Will about it');
assert.equal(fix('then bens slides', ['Ben']).text, 'then bens slides');

console.log('lexicon tests: passed');
