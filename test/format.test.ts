import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, httpsImage, render } from '../src/format.ts';

test('renders the country into the Stripe product name', () => {
  const { text, missing } = render('Flag & Seal Kit - {country}', { country: 'Japan' });
  assert.equal(clean(text, 250), 'Flag & Seal Kit - Japan');
  assert.deepEqual(missing, []);
});

test('reports placeholders the country has no data for instead of rendering blanks', () => {
  const { missing } = render('Postcards of {capital}, {country}', {
    country: 'Antarctica',
    capital: null,
  });
  assert.deepEqual(missing, ['capital']);
});

test('strips control characters and truncates to the Stripe limit', () => {
  assert.equal(clean("Kit \u0009 -\n  C\u00f4te d\u0007Ivoire", 250), "Kit - C\u00f4te d Ivoire");
  assert.equal(clean('x'.repeat(300), 250).length, 250);
});

test('only plain https flag URLs reach Stripe', () => {
  assert.equal(httpsImage('https://flagcdn.com/w320/jp.png'), 'https://flagcdn.com/w320/jp.png');
  assert.equal(httpsImage('http://flagcdn.com/w320/jp.png'), null);
  assert.equal(httpsImage('javascript:alert(1)'), null);
  assert.equal(httpsImage('data:image/png;base64,AAAA'), null);
  assert.equal(httpsImage('https://user:pw@evil.test/x.png'), null);
  assert.equal(httpsImage('not a url'), null);
});
