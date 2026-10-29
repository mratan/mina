// Caller-supplied linkage (source.article_url/ref/doi/version/label) is reported with URL credentials redacted, in
// both details.linkage and the rendered text, on success and on failure. It stays labelled caller-supplied/unverified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupplementService } from '../supplements.mjs';
import { fakeHttp, fakeResolve, reply } from './supplement-fixtures.mjs';

const NOW = () => new Date('2026-10-23T12:00:00.000Z');
const URL_OK = 'https://files.example.org/suppl/t.csv';
const URL_DENIED = 'https://files.example.org/suppl/denied.csv';
const CANARIES = ['SIGCANARY111', 'TOKCANARY222', 'PWCANARY333', 'NESTEDCANARY444', 'DOICANARY555', 'LABELCANARY666'];
const SOURCE = {
  article_url: 'https://user:PWCANARY333@cdn.example.org/article.pdf?X-Amz-Signature=SIGCANARY111&token=TOKCANARY222'
    + '&next=https%3A%2F%2Fb.example%2Ff%3FX-Amz-Signature%3DNESTEDCANARY444&page=3',
  ref: 'Supplementary Data 2',
  doi: 'https://doi.org/10.1000/xyz?access_token=DOICANARY555',
  version: 'published 2024-05-01',
  label: 'see https://example.org/s?sig=LABELCANARY666',
};

const svc = () => createSupplementService({ http: fakeHttp({
  [URL_OK]: reply(200, 'a,b\n1,2\n', { 'content-type': 'text/csv' }),
  [URL_DENIED]: reply(403, '<html>Access Denied</html>', { 'content-type': 'text/html' }),
}), resolve: fakeResolve, now: NOW });

for (const [name, url] of [['success', URL_OK], ['failure', URL_DENIED]]) {
  test(`linkage: signed-URL canaries in source are redacted in details and text (${name})`, async () => {
    const r = await svc().get({ url, operation: 'extract', source: SOURCE });
    const dump = `${r.text}\n${JSON.stringify(r.details)}`;
    for (const c of CANARIES) assert.ok(!dump.includes(c), `${name}: ${c} leaked`);
    const l = r.details.linkage;
    assert.equal(l.verified, false);
    assert.match(l.note, /caller/i);
    assert.match(l.caller_supplied.article_url, /^https:\/\/\[redacted\]@cdn\.example\.org\/article\.pdf\?X-Amz-Signature=\[redacted\]&token=\[redacted\]&next=/);
    assert.match(l.caller_supplied.article_url, /&page=3$/, 'non-secret parameters are kept');
    assert.equal(l.caller_supplied.ref, 'Supplementary Data 2', 'plain text is unchanged');
    assert.equal(l.caller_supplied.version, 'published 2024-05-01');
    assert.equal(l.caller_supplied.doi, 'https://doi.org/10.1000/xyz?access_token=[redacted]');
    assert.match(r.text, /Linkage \(caller-supplied, NOT verified\): article_url https:\/\/\[redacted\]@cdn\.example\.org/);
  });
}
