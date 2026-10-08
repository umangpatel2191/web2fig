import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, isPrivateAddress } from '../helper/safety.ts';

test('private, loopback, link-local and metadata addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip'])
    assert.equal(isPrivateAddress(ip), true, ip);
});

test('ordinary public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111'])
    assert.equal(isPrivateAddress(ip), false, ip);
});

test('assertPublicUrl refuses dangerous links before any request is made', async () => {
  for (const url of [
    'http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.1/',
    'file:///etc/passwd', 'ftp://example.com/', 'http://user:pass@example.com/', 'https://example.com:22/', 'http://metadata.google.internal/', 'http://printer.local/',
  ])
    await assert.rejects(assertPublicUrl(url), undefined, url);
});

test('assertPublicUrl accepts a public IP literal on a normal port', async () => {
  await assertPublicUrl('https://93.184.216.34/');
  await assertPublicUrl('http://8.8.8.8:8080/page');
});
