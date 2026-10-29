import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicFetchPolicy, isNonPublicAddress, parsePublicHttpUrl, MAX_URL_LENGTH } from '../src/net-guard.js';

test('non-public address classes are refused', () => {
  for (const a of ['127.0.0.1', '127.255.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '100.127.255.254', '0.0.0.0', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1',
    'fc00::1', 'fd7a:115c:a1e0::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::1', '2001:db8::1', 'ff02::1']) {
    assert.equal(isNonPublicAddress(a), true, a);
  }
  for (const a of ['93.184.215.14', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '100.128.0.1']) {
    assert.equal(isNonPublicAddress(a), false, a);
  }
});

test('static URL refusals', () => {
  const refused = ['file:///etc/passwd', 'ftp://example.com/', 'gopher://x/', 'http://localhost/', 'http://foo.localhost/',
    'http://127.0.0.1/', 'http://0x7f000001/', 'http://2130706433/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/', 'http://user:pass@example.com/', 'not a url',
    `https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`];
  for (const u of refused) assert.throws(() => parsePublicHttpUrl(u), undefined, u);
  assert.equal(parsePublicHttpUrl('https://example.com/a?b=1').hostname, 'example.com');
});

test('DNS answers are vetted: any non-public address refuses (rebinding defense), public returns a pinned address', async () => {
  const fake = (map) => async (h) => map[h] ?? [];
  const policy = createPublicFetchPolicy({ resolve: fake({
    'rebind.test': [{ address: '93.184.215.14', family: 4 }, { address: '127.0.0.1', family: 4 }],
    'private.test': [{ address: '10.0.0.5', family: 4 }],
    'v6ula.test': [{ address: 'fd00::1', family: 6 }],
    'ok.test': [{ address: '93.184.215.14', family: 4 }],
  }) });
  await assert.rejects(policy.check('https://rebind.test/'), /non-public address 127\.0\.0\.1/);
  await assert.rejects(policy.check('https://private.test/'), /10\.0\.0\.5/);
  await assert.rejects(policy.check('https://v6ula.test/'), /fd00::1/);
  await assert.rejects(policy.check('https://nxdomain.test/'), /Could not resolve/);
  assert.deepEqual(await policy.check('https://ok.test/x'), { address: '93.184.215.14', family: 4 });
});

test('explicit allowHosts bypasses the private-address refusal only for the listed host[:port]', async () => {
  const policy = createPublicFetchPolicy({ allowHosts: ['127.0.0.1:9999'], resolve: async () => [] });
  assert.equal(await policy.check('http://127.0.0.1:9999/x'), null);
  await assert.rejects(policy.check('http://127.0.0.1:9998/x'));
  await assert.rejects(policy.check('http://localhost:9999/x'));
});
