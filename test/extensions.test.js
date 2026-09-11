import test from 'ava'
import {
  parseNotes,
  formatNotes,
  stripExtensionsBlock,
  ExtensionsError,
} from '../src/formats/codecs/extensions.ts'

test('empty notes → empty user text and extensions', t => {
  t.deepEqual(parseNotes(''), { userText: '', extensions: {} })
  t.deepEqual(parseNotes(null), { userText: '', extensions: {} })
  t.deepEqual(parseNotes(undefined), { userText: '', extensions: {} })
})

test('plain user text with no fence → userText untouched, extensions empty', t => {
  const text = 'Some free text\nover several lines.'
  t.deepEqual(parseNotes(text), { userText: text, extensions: {} })
})

test('fenced block yields extensions and preserves surrounding text', t => {
  const text = [
    'Prologue line.',
    '',
    '--- gitmap-extensions v1 ---',
    '{',
    '  "club/season": "2026-summer",',
    '  "printer/last_run": "2026-05-12"',
    '}',
    '--- end gitmap-extensions ---',
    '',
    'Postscript line.',
  ].join('\n')
  const { userText, extensions } = parseNotes(text)
  t.deepEqual(extensions, {
    'club/season': '2026-summer',
    'printer/last_run': '2026-05-12',
  })
  t.is(userText, 'Prologue line.\n\nPostscript line.')
})

test('unknown fence version is preserved verbatim, not an error', t => {
  // A reader that doesn't know the block version leaves the notes field intact
  // (the block rides through as user text) rather than dropping it or aborting.
  const text =
    '--- gitmap-extensions v99 ---\n{}\n--- end gitmap-extensions ---'
  t.deepEqual(parseNotes(text), { userText: text, extensions: {} })
})

test('missing close fence throws', t => {
  t.throws(() => parseNotes('--- gitmap-extensions v1 ---\n{"a":1}\n'), {
    instanceOf: ExtensionsError,
  })
})

test('nested open fence throws', t => {
  const text = [
    '--- gitmap-extensions v1 ---',
    '--- gitmap-extensions v1 ---',
    '{}',
    '--- end gitmap-extensions ---',
  ].join('\n')
  t.throws(() => parseNotes(text), { instanceOf: ExtensionsError })
})

test('malformed JSON body throws', t => {
  const text = [
    '--- gitmap-extensions v1 ---',
    '{not json',
    '--- end gitmap-extensions ---',
  ].join('\n')
  t.throws(() => parseNotes(text), { instanceOf: ExtensionsError })
})

test('non-object body throws', t => {
  const text = [
    '--- gitmap-extensions v1 ---',
    '[]',
    '--- end gitmap-extensions ---',
  ].join('\n')
  t.throws(() => parseNotes(text), { instanceOf: ExtensionsError })
})

test('formatNotes with no extensions returns only user text', t => {
  t.is(formatNotes('hello', {}), 'hello')
  t.is(formatNotes('hello', null), 'hello')
  t.is(formatNotes('', {}), '')
})

test('formatNotes emits sorted keys and stable JSON', t => {
  const out = formatNotes('user note', { z: 1, a: 2, m: { b: 1, a: 2 } })
  t.true(out.startsWith('user note\n\n--- gitmap-extensions v1 ---\n'))
  t.true(out.endsWith('\n--- end gitmap-extensions ---'))
  // Extract JSON body and confirm keys are sorted deeply.
  const body = out.match(/^\{[\s\S]*\}$/m)[0]
  // JSON.stringify traverses depth-first, so nested keys of 'm' appear
  // between 'm' and 'z'.
  const keys = Array.from(body.matchAll(/"([a-z])":/g)).map(m => m[1])
  t.deepEqual(keys, ['a', 'm', 'a', 'b', 'z'])
})

test('formatNotes emits only the block when user text is empty', t => {
  const out = formatNotes('', { k: 1 })
  t.is(
    out,
    '--- gitmap-extensions v1 ---\n{\n  "k": 1\n}\n--- end gitmap-extensions ---',
  )
})

test('round-trip: parseNotes(formatNotes(u, e)) === {u, e}', t => {
  const extensions = {
    'club/season': '2026-summer',
    'mapwall/publish_state': 'draft',
    numeric_bare: 42,
    'vendor/nested': { flag: true, list: [1, 2, 3] },
  }
  const userText = 'Line one.\n\nLine two.'
  const notes = formatNotes(userText, extensions)
  const parsed = parseNotes(notes)
  t.is(parsed.userText, userText)
  t.deepEqual(parsed.extensions, extensions)
})

test('stripExtensionsBlock removes the block only', t => {
  const text = [
    'Head.',
    '',
    '--- gitmap-extensions v1 ---',
    '{"a": 1}',
    '--- end gitmap-extensions ---',
    '',
    'Tail.',
  ].join('\n')
  t.is(stripExtensionsBlock(text), 'Head.\n\nTail.')
  t.is(stripExtensionsBlock('no fence here'), 'no fence here')
})

test('formatNotes strips a stale block from user text before re-emitting', t => {
  const stale = [
    'Head.',
    '--- gitmap-extensions v1 ---',
    '{"old": true}',
    '--- end gitmap-extensions ---',
  ].join('\n')
  const out = formatNotes(stale, { fresh: true })
  const parsed = parseNotes(out)
  t.is(parsed.userText, 'Head.')
  t.deepEqual(parsed.extensions, { fresh: true })
})
