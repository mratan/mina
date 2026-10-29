#!/usr/bin/env python3
# watch-run.py <work dir> [--stall S] [--server URL] [--from-end] : one line per event for a mina test run (for a monitor).
# --from-end skips what the current session file already holds (no replay of old events).
# Events: each tool call (with ERR when its result failed), goal status changes (pi-goal and mina), model errors,
# COMPACTION and CONTEXT EDIT entries (pi-hot-compact), NEW SESSION and HANDOFF NOTE (mina handoff),
# STALL when the newest session file has not grown for --stall seconds (default 300) while the run is alive and no
# server slot is generating (BUSY with the slot's token count when one is: long replies reach the file only at the end),
# SERVER DOWN/UP for a local model server, and EXIT when no process works in the folder any more. Polls every 15 s.
# --server URL (or MINA_WATCH_SERVER) is the server's health endpoint, e.g. a llama.cpp server's http://HOST:PORT/health;
# its /slots endpoint gives BUSY. Without one, the server checks are off.
import json, os, subprocess, sys, time, urllib.request, glob

d = os.path.abspath(sys.argv[1])
stall = float(sys.argv[sys.argv.index('--stall') + 1]) if '--stall' in sys.argv else 300
server = sys.argv[sys.argv.index('--server') + 1] if '--server' in sys.argv else os.environ.get('MINA_WATCH_SERVER') or None
say = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)

def alive():
    out = subprocess.run(['ps', '-eo', 'pid,args'], capture_output=True, text=True).stdout
    return any(d in l and ('goal-rpc' in l or 'probe.py' in l) for l in out.splitlines())

def busy_slots():
    # Server slots that are generating: [(slot, tokens decoded)]; None without a server or when it has no /slots.
    if not server: return None
    try:
        slots = json.load(urllib.request.urlopen(server.replace('/health', '/slots'), timeout=5))
        return [(s['id'], (s.get('next_token') or [{}])[0].get('n_decoded', 0) if isinstance(s.get('next_token'), list) else 0) for s in slots if s.get('is_processing')]
    except Exception: return None

def newest():
    files = [os.path.join(r, n) for r, _, ns in os.walk(d) for n in ns if n.endswith('.jsonl')]  # glob skips hidden folders
    return max(files, key=os.path.getmtime) if files else None

seen, pos, cur, last_growth, server_ok, statuses = set(), 0, None, time.time(), True, {}
say('WATCH', d, 'alive' if alive() else 'NOT RUNNING', '| session', newest() or 'none yet')
if '--from-end' in sys.argv and newest(): cur = newest(); pos = os.path.getsize(cur)
while True:
    f = newest()
    if f != cur:
        if cur: say('NEW SESSION', os.path.basename(f), '(handoff from', os.path.basename(cur) + ')')
        cur, pos = f, 0
    if f:
        size = os.path.getsize(f)
        if size > pos:
            last_growth = time.time()
            with open(f) as fh:
                fh.seek(pos); chunk = fh.read(); pos = size
            for line in chunk.splitlines():
                try: e = json.loads(line)
                except Exception: continue
                if e.get('type') == 'message':
                    m = e['message']
                    if m.get('role') == 'assistant':
                        if m.get('stopReason') == 'error': say('MODEL ERROR', str(m.get('errorMessage'))[:200])
                        for c in m.get('content', []):
                            if c.get('type') == 'toolCall':
                                seen.add(c.get('id')); say('call', c.get('name'), json.dumps(c.get('arguments'))[:90])
                                if c.get('name') == 'mina_handoff_note': say('HANDOFF NOTE', str((c.get('arguments') or {}).get('state', ''))[:160])
                    elif m.get('role') == 'toolResult' and m.get('isError'):
                        say('  ERR', m.get('toolName'), json.dumps(m.get('content'))[:160])
                elif e.get('type') == 'compaction':
                    say('COMPACTION', f"tokens before {e.get('tokensBefore', '?')}, summary {len(str(e.get('summary', '')))} chars, first kept {e.get('firstKeptEntryId', '?')}")
                elif e.get('type') == 'context_edit':
                    say('CONTEXT EDIT', str(e.get('targetId', ''))[:40])
                elif e.get('type') == 'custom' and e.get('customType') in ('goal-state', 'mina-goal'):
                    data = e.get('data') or {}
                    s = (data.get('goal') or {}).get('status') if e['customType'] == 'goal-state' else data.get('status')
                    if s and statuses.get(e['customType']) != s:
                        statuses[e['customType']] = s; say('STATUS', e['customType'], s)
    if server:
        try:
            urllib.request.urlopen(server, timeout=5); ok = True
        except Exception: ok = False
        if ok != server_ok: server_ok = ok; say('SERVER', 'UP' if ok else 'DOWN', server)
    if not alive():
        say('EXIT', 'no run process in', d, '| statuses', json.dumps(statuses)); break
    if time.time() - last_growth > stall:
        b = busy_slots()
        if b: say('BUSY', f'session unchanged for {int(time.time() - last_growth)} s, but the server is generating:', ', '.join(f'slot {i} {n} tokens' for i, n in b))
        else: say('STALL', f'session unchanged for {int(time.time() - last_growth)} s and no server slot is generating' if b == [] else f'session unchanged for {int(time.time() - last_growth)} s')
        last_growth = time.time()
    time.sleep(15)
