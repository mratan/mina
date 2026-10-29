#!/usr/bin/env python3
# probe.py <dir> <mode> [prompt] : one run through mina; first-prompt tokens, time to first token, tools, errors.
# The model (provider/id) comes from PROBE_MODEL, else MINA_MODEL; one of them is required.
# PROBE_SESSION_DIR=<dir> keeps the session there (needed for /goal); otherwise --no-session.
import json, subprocess, sys, time, os
if len(sys.argv) < 3: sys.exit('usage: PROBE_MODEL=provider/id probe.py <dir> <full|fast|lean> [prompt]')
model = os.environ.get('PROBE_MODEL') or os.environ.get('MINA_MODEL')
if not model: sys.exit('probe.py: set PROBE_MODEL (or MINA_MODEL) to provider/id')
d, mode = sys.argv[1], sys.argv[2]
prompt = sys.argv[3] if len(sys.argv) > 3 else "Reply with the single word OK."
cmd = [os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'bin', 'mina.mjs'), f'--{mode}', '--model', model, *(['--session-dir', os.environ['PROBE_SESSION_DIR']] if os.environ.get('PROBE_SESSION_DIR') else ['--no-session']), '--mode', 'json', '-p', prompt]
t0 = time.time(); first = None; usage = None; tools = None; calls = []; results = []; errs = []
p = subprocess.Popen(cmd, cwd=d, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
for line in p.stdout:
    try: e = json.loads(line)
    except Exception: continue
    t = e.get('type')
    if t == 'message_start' and e['message'].get('role') == 'system':
        tools = e['message'].get('sections', {}).get('tools', '')
    if t == 'message_update' and first is None: first = time.time() - t0
    if t == 'message_end' and e['message'].get('role') == 'assistant':
        if usage is None: usage = e['message'].get('usage')
        for c in e['message']['content']:
            if c.get('type') == 'toolCall': calls.append({'name': c.get('name'), 'args': c.get('arguments')})
        if e['message'].get('stopReason') == 'error': errs.append(e['message'].get('errorMessage'))
    if t == 'tool_execution_end': results.append({'name': e.get('toolName'), 'isError': e.get('isError'), 'text': json.dumps(e.get('result'))[:300]})
    if t == 'message_end' and e['message'].get('role') == 'assistant': last = e['message']
p.wait(); err = p.stderr.read()
final = ''.join(c.get('text', '') for c in last['content'] if c.get('type') == 'text') if 'last' in locals() else ''
tool_names = [l.split(':')[0].strip('- ') for l in (tools or '').splitlines() if l.startswith('- ')]
print(json.dumps({'dir': d, 'mode': mode, 'first_input_tokens': (usage or {}).get('input'), 'ttft_s': round(first or -1, 1),
  'wall_s': round(time.time() - t0, 1), 'tools': tool_names, 'calls': calls, 'results': results, 'errors': errs,
  'final': final[-1500:], 'stderr': err[-600:]}, indent=1))
