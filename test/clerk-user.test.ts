import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primaryEmail } from '../src/clerkUser.ts';

test('picks the address matching primary_email_address_id', () => {
  const email = primaryEmail({
    primary_email_address_id: 'idn_2',
    email_addresses: [
      { id: 'idn_1', email_address: 'old@example.com' },
      { id: 'idn_2', email_address: 'primary@example.com' },
    ],
  });
  assert.equal(email, 'primary@example.com');
});

test('falls back to the first address when no primary is set yet', () => {
  const email = primaryEmail({
    primary_email_address_id: null,
    email_addresses: [{ id: 'idn_1', email_address: 'only@example.com' }],
  });
  assert.equal(email, 'only@example.com');
});

test('no addresses at all is null, not a crash', () => {
  assert.equal(primaryEmail({ primary_email_address_id: null, email_addresses: [] }), null);
});
