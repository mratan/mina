#!/usr/bin/env python3
"""Economics of compaction thresholds for mina sessions, from measured workload parameters (IV-0 Sol, IV-1a Claude).
usage: python3 scripts/threshold-economics.py scripts/threshold-economics.json (docs/threshold-economics.md)

A session: fresh start at baseline B, reorientation of R tokens (re-reading inputs), then work requests that each add g
tokens and produce o output tokens. Hot compaction at C summarises the context (one uncached summary request over the
context, s_out output) and leaves A0 + k*C. After max_c compactions the session hands off at C (mina's rule): a note
request, then a fresh successor. Each request re-reads the previous context from cache and writes its new tokens.
Costs are per 1,000 *work* requests (reorientation requests are overhead), under three usage formulas.
"""
import json, sys

def simulate(m, C, max_c=2, work=20000):
    g, o, B, R, gr, A0, k, s_out = m['g'], m['o'], m['B'], m['R'], m['g_reorient'], m['A0'], m['k'], m['s_out']
    tiers = m['price']
    def price(prompt):  # whole request at the tier its prompt reaches (cached tokens count toward the threshold)
        p = dict(tiers['base'])
        for t in tiers.get('tiers', []):
            if prompt > t['above']: p = t
        return p
    acc = {'api': 0.0, 'no_cache_reads': 0.0, 'naive': 0.0}
    stats = {'requests': 0, 'compactions': 0, 'handoffs': 0, 'ctx_sum': 0.0}
    def request(prev, new_in, out):
        p = price(prev + new_in)
        write = new_in * (p['cache_write'] if 'cache_write' in p else p['input'])
        acc['api'] += (prev * p['cache_read'] + write + out * p['output']) / 1e6
        acc['no_cache_reads'] += (write + out * p['output']) / 1e6
        acc['naive'] += ((prev + new_in) * p['input'] + out * p['output']) / 1e6
        stats['requests'] += 1; stats['ctx_sum'] += prev + new_in
    def summary(ctx):  # one-shot summary over the whole context: no cache hit
        p = price(ctx)
        cost = (ctx * p.get('cache_write_oneshot', p['input']) + s_out * p['output']) / 1e6
        for key in acc: acc[key] += cost if key != 'naive' else (ctx * p['input'] + s_out * p['output']) / 1e6
        stats['compactions'] += 1
    done = 0
    while done < work:
        ctx = B; request(0, B, o)                      # fresh session: system prompt, tools, packet
        r = 0
        while r < R:                                   # reorientation: re-read inputs (overhead, not work)
            request(ctx, gr, o); ctx += gr + o; r += gr
        compactions = 0
        while done < work:
            request(ctx, g, o); ctx += g + o; done += 1
            if ctx >= C:
                if compactions >= max_c:
                    request(ctx, 500, m['note_out']); stats['handoffs'] += 1; break
                summary(ctx); compactions += 1; ctx = A0 + k * ctx
    per = 1000 / work
    return {**{k: v * per for k, v in acc.items()}, 'compactions': stats['compactions'] * per, 'handoffs': stats['handoffs'] * per,
            'avg_ctx': stats['ctx_sum'] / stats['requests'], 'overhead_requests': (stats['requests'] - work) * per}

if __name__ == '__main__':
    models = json.load(open(sys.argv[1]))
    for name, m in models.items():
        print(f"\n{name}  (prices per 1M: {json.dumps(m['price'])})")
        print(f"{'C':>6} {'avg ctx':>8} {'compact':>8} {'handoff':>8} {'overhd':>7} | {'API-equiv $':>11} {'vs160K':>7} | {'no-cache-read $':>15} {'vs160K':>7} | {'naive $':>8}")
        base = simulate(m, 160_000)
        for C in m['grid']:
            r = simulate(m, C)
            print(f"{C//1000:>5}K {r['avg_ctx']/1000:>7.0f}K {r['compactions']:>8.1f} {r['handoffs']:>8.1f} {r['overhead_requests']:>7.0f} | "
                  f"{r['api']:>11.2f} {r['api']/base['api']:>6.2f}x | {r['no_cache_reads']:>15.2f} {r['no_cache_reads']/base['no_cache_reads']:>6.2f}x | {r['naive']:>8.2f}")
