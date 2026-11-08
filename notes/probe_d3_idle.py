#!/usr/bin/env python3
"""Probe D3: does the 16K prompt cache survive an idle table? And what does a cache miss actually cost?

Probe D2 was contaminated at exactly this question: the idle case ran right after a head edit, so the cache it
was compared against had already been replaced by a different sequence. 150.9s there measured my own ordering,
not the passage of time. This script has one job and one variable: nothing destructive runs before the idle
measurement, and the two appends are the only change.

  cold          unseen prefix, empty cache - the number the game must never pay mid-session
  warm          byte-identical
  append_1      one new user turn (the game's normal round)
  --- IDLE 90s  players argue about a door for a minute and a half ---
  append_2      one more turn, nothing else changed
  grow_8        eight turns in a row, to see whether reuse degrades as a session lengthens

Then rerun it unchanged after a server relaunch with different KV cache flags: the comparison is one variable.
"""
import json, os, sys, time, datetime, urllib.request

URL = 'http://127.0.0.1:8080/v1/chat/completions'
MODEL = r'C:\dm\models\Hermes3.6-35B-A3B-MTP-MXFP4exp-Q4K_S.gguf'
RULES = r'C:\Users\jommy\Documents\Dungeon-Blaster\rules\rules.md'
OUT = os.environ.get('OUT', r'C:\Users\jommy\Documents\Dungeon-Blaster\notes\probe-d3-results.json')
NONCE = 'run %s ' % datetime.datetime.now().strftime('%H%M%S%f')
SIZE = int(os.environ.get('SIZE', '16000'))
IDLE_SEC = int(os.environ.get('IDLE_SEC', '90'))
LABEL = os.environ.get('LABEL', 'f16 cache, cache-reuse 8192')

FILLER = ('Round recap: the party argued about a door, a goblin survived an unlucky round, somebody looted a '
          'cracked brazier, the torch burned down another inch, and the DM described the smell as wet pennies '
          'and old jam. ')


def build(n):
    rules = open(RULES, encoding='utf-8').read()[:6000] if os.path.exists(RULES) else 'rulebook\n'
    body = ['You are the Dungeon Master. The tracker is the source of truth. Rulebook is law.\n',
            NONCE, rules, '\n\nTRANSCRIPT:\n']
    i = 0
    while True:
        body.append('[%d] player: we try the door. dm: %s\n' % (i, FILLER))
        i += 1
        if sum(len(x) for x in body) / 3.6 >= n:
            break
    return ''.join(body)


def call(system, hist, max_tokens=16):
    body = json.dumps({'model': MODEL,
                       'messages': [{'role': 'system', 'content': system}] + hist,
                       'max_tokens': max_tokens, 'temperature': 0.2, 'stream': True,
                       'stream_options': {'include_usage': True},
                       'chat_template_kwargs': {'enable_thinking': False}}).encode()
    req = urllib.request.Request(URL, data=body, headers={'Content-Type': 'application/json'})
    t0 = time.perf_counter(); ttft = None; ptok = ctok = None
    with urllib.request.urlopen(req, timeout=900) as r:
        for raw in r:
            line = raw.decode('utf-8', 'replace').strip()
            if not line.startswith('data: '):
                continue
            p = line[6:]
            if p == '[DONE]':
                break
            try:
                d = json.loads(p)
            except Exception:
                continue
            ch = (d.get('choices') or [{}])[0]
            if ttft is None and (ch.get('delta', {}).get('content') or ch.get('delta', {}).get('tool_calls')):
                ttft = time.perf_counter() - t0
            u = d.get('usage') or {}
            ptok = u.get('prompt_tokens', ptok); ctok = u.get('completion_tokens', ctok)
    tot = time.perf_counter() - t0
    ttft = ttft or tot
    return {'ttft': round(ttft, 3), 'total': round(tot, 3), 'ptok': ptok, 'ctok': ctok,
            'eval_rate': round(ptok / ttft) if ptok and ttft else None}


def main():
    power = os.popen('powercfg -getactivescheme').read().strip().split('(')[-1].rstrip(')')
    print('power: %s   size: %d   flags under test: %s' % (power, SIZE, LABEL), flush=True)
    prefix = build(SIZE)
    res = {'at': datetime.datetime.now().isoformat(), 'power': power, 'label': LABEL, 'cases': []}
    print('%-14s %8s %8s %8s %10s' % ('case', 'ptok', 'ttft', 'total', 'ptok/s'), flush=True)

    def run(case, hist):
        r = call(prefix, hist)
        r['case'] = case
        res['cases'].append(r)
        print('%-14s %8s %8s %8s %10s' % (case, r['ptok'], r['ttft'], r['total'], r['eval_rate']), flush=True)
        json.dump(res, open(OUT, 'w'), indent=1)
        return r

    q = [{'role': 'user', 'content': 'What do the party see?'}]
    run('cold', q)
    run('warm', q)
    run('append_1', q + [{'role': 'assistant', 'content': 'Salt, rust, and a door that has been opened before.'},
                         {'role': 'user', 'content': 'We push it open.'}])
    print('  idle %ds (nothing is allowed to touch the prefix in here)...' % IDLE_SEC, flush=True)
    time.sleep(IDLE_SEC)
    a2 = run('append_2', q + [{'role': 'assistant', 'content': 'It swings.'},
                              {'role': 'user', 'content': 'Torch up, walk in.'}])
    for k in range(3, 10):
        run('grow_%d' % k, q + [{'role': 'user', 'content': 'round %d: we go deeper, %s' % (k, FILLER[:60])}])
    w = res['cases'][1]
    print('\n=== verdict ===')
    print('  cache miss at %d tokens costs %.1fs; a reused turn costs %.2fs (%.0fx)'
          % (res['cases'][0]['ptok'] or SIZE, res['cases'][0]['ttft'], w['ttft'],
             res['cases'][0]['ttft'] / max(w['ttft'], 0.001)))
    print('  after %ds idle: %.2fs -> %s' % (IDLE_SEC, a2['ttft'],
          'CACHE SURVIVED' if a2['ttft'] < 0.25 * res['cases'][0]['ttft'] else 'CACHE WAS GONE'))
    print('wrote', OUT)


main()
