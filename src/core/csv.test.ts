import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCsvText, splitCsvText } from './csv.js';

test('splitCsvText：中英文逗号都是分隔符，去空白去空项', () => {
  assert.deepEqual(splitCsvText('a, b'), ['a', 'b']);
  assert.deepEqual(splitCsvText('a，b，，c'), ['a', 'b', 'c'], '中文逗号与连续分隔符');
  assert.deepEqual(splitCsvText(' a ,， b '), ['a', 'b'], '混用 + 空白');
  assert.deepEqual(splitCsvText(''), []);
  assert.deepEqual(splitCsvText('  '), []);
  assert.deepEqual(splitCsvText(null), []);
  assert.deepEqual(splitCsvText(undefined), []);
});

test('normalizeCsvText：中文逗号归一成英文，其余不动', () => {
  assert.equal(normalizeCsvText('a，b, c'), 'a,b, c');
  assert.equal(normalizeCsvText('sk-1'), 'sk-1');
  assert.equal(normalizeCsvText(''), '');
});
