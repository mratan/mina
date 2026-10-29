#!/usr/bin/env python3
# goal-rpc.py <dir> <mode> <model> "<goal arguments>" [--answer Accept|Edit|Decline] [--timeout S] [--session FILE --prompt TEXT]
# --session resumes a saved session; --prompt sends TEXT as is instead of "/goal <goal arguments>".
# Runs one mina /goal in Pi's RPC mode (print mode exits before pi-goal's first turn). Dialogs are answered with --answer
# (an "Edit" answer keeps the proposed text). Stops when the goal completes, when Pi stays idle for 30 s, or at
# --timeout if one is given (none by default: watch runs with watch-run.py). It never stops a run for silence while the agent works (a landscape search can take minutes): watch for
# stalls with watch-run.py instead.
# Prints a JSON summary: tool calls, failed tool results, notifications, timing, usage.
import json, os, subprocess, sys, threading, time, queue

args = sys.argv[1:]
d, mode, model, goal = args[0], args[1], args[2], args[3]
answer = args[args.index('--answer') + 1] if '--answer' in args else 'Accept'
limit = float(args[args.index('--timeout') + 1]) if '--timeout' in args else float('inf')  # no limit unless asked: runs are monitored
mina = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'bin', 'mina.mjs')
sessions = os.environ.get('PROBE_SESSION_DIR', os.path.join(d, '.mina-test-sessions'))
resume = ['--session', args[args.index('--session') + 1]] if '--session' in args else []
first = args[args.index('--prompt') + 1] if '--prompt' in args else f'/goal {goal}'
p = subprocess.Popen([mina, f'--{mode}', '--model', model, '--session-dir', sessions, *resume, '--mode', 'rpc'], cwd=d,
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
q = queue.Queue()
threading.Thread(target=lambda: [q.put(l) for l in p.stdout], daemon=True).start()
send = lambda obj: (p.stdin.write(json.dumps(obj) + '\n'), p.stdin.flush())
send({'id': 'goal-1', 'type': 'prompt', 'message': first})

t0 = time.time(); calls, failed, notes, dialogs, usage = [], [], [], [], {'input': 0, 'output': 0, 'requests': 0}
idle_since, running, done, why = None, False, False, 'timeout'
last_event = time.time()
while time.time() - t0 < limit:
    try: line = q.get(timeout=1)
    except queue.Empty:
        if idle_since and not running and time.time() - idle_since > 30: why = 'idle 30 s'; break
        if not running and time.time() - last_event > 60: why = 'idle, no events for 60 s'; break
        continue
    last_event = time.time()
    try: e = json.loads(line)
    except Exception: continue
    t = e.get('type')
    if t == 'agent_start': running = True
    if t in ('agent_end', 'agent_settled'): running = False; idle_since = time.time()
    if t == 'message_end' and e['message'].get('role') == 'assistant':
        u = e['message'].get('usage') or {}; usage['input'] += u.get('input', 0); usage['output'] += u.get('output', 0); usage['requests'] += 1
        for c in e['message']['content']:
            if c.get('type') == 'toolCall': calls.append({'t': round(time.time() - t0), 'name': c.get('name'), 'args': json.dumps(c.get('arguments'))[:240]})
        if e['message'].get('stopReason') == 'error': failed.append({'model_error': e['message'].get('errorMessage')})
    if t == 'tool_execution_end' and e.get('isError'):
        failed.append({'tool': e.get('toolName'), 'text': json.dumps(e.get('result'))[:400]})
    if t == 'extension_ui_request':
        m = e.get('method')
        if m == 'notify':
            notes.append({'t': round(time.time() - t0), 'text': e.get('message', '')[:400]})
            if 'goal complete' in e.get('message', '').lower(): done, why = True, 'goal complete'
        elif m == 'select':
            opts = e.get('options', []); pick = next((o for o in opts if o.startswith(answer)), opts[0] if opts else None)
            dialogs.append({'title': e.get('title', '')[:600], 'answer': pick}); send({'type': 'extension_ui_response', 'id': e['id'], 'value': pick})
        elif m == 'editor':
            dialogs.append({'editor': e.get('title', ''), 'answer': 'kept'}); send({'type': 'extension_ui_response', 'id': e['id'], 'value': e.get('prefill', '')})
        elif m in ('confirm',):
            send({'type': 'extension_ui_response', 'id': e['id'], 'confirmed': True})
        elif m == 'input':
            send({'type': 'extension_ui_response', 'id': e['id'], 'cancelled': True})
    if done and not running: break
    if done and time.time() - t0 > limit: break
p.terminate()
try: p.wait(timeout=10)
except Exception: p.kill()
print(json.dumps({'stopped': why, 'wall_s': round(time.time() - t0), 'usage': usage, 'calls': calls, 'failed': failed, 'notes': notes,
                  'dialogs': dialogs, 'stderr': p.stderr.read()[-800:]}, indent=1))
