#!/usr/bin/env python3
"""Probe D2: which prompt edits are free, and which cost a full re-eval, at 16K context.

Probe D said warm reuse is excellent (~0.4s for a 2.2K prompt) and the cache survives 90s idle, but it also
said the same "append inside the system block" case cost 10.9s once and 0.26s once. That is the case the game
depends on: world state (inventory, positions, gold) lives in the system block and changes every round. If
touching it costs a full re-eval at the measured ~500 tok/s, a 16K round costs ~30s of prompt eval before the
DM says a word, and the layout is wrong.

So: one size, the game's real shapes, each measured twice, with the position of the edit varied. A case that
flips between runs is itself the result, which is why nothing here is averaged.

  cold            unseen prefix (per-run nonce) - true prompt eval cost
  warm            byte-identical
  append_turn     one new user turn at the end  <- the game's normal round
  state_40pct     one digit changed at ~40% into the system block  <- "gold: 12" -> "gold: 13"
  state_90pct     one digit changed at ~90% depth
  state_head      one digit changed at the very start
  idle_90s        90 seconds of silence, then append_turn (players talk longer than this)
  again_state     state_40pct repeated - ordering effects, since probe D caught one case flipping
"""
import json, os, sys, time, datetime, urllib.request

URL = 'http://127.0.0.1:8080/v1/chat/completions'
MODEL = r'C:\dm\models\Hermes3.6-35B-A3B-MTP-MXFP4exp-Q4K_S.gguf'
RULES = r'C:\Users\jommy\Documents\Dungeon-Blaster\rules\rules.md'
OUT = r'C:\Users\jommy\Documents\Dungeon-Blaster\notes\probe-d2-results.json'
NONCE = 'run %s ' % datetime.datetime.now().strftime('%H%M%S%f')
SIZE = int(os.environ.get('SIZE', '16000'))
IDLE_SEC = int(os.environ.get('IDLE_SEC', '90'))

FILLER = ('Round recap: the party argued about a door, a goblin survived an unlucky round, somebody looted a '
          'cracked brazier, the torch burned down another inch, and the DM described the smell as wet pennies '
          'and old jam. ')
STATE = '\n\nWORLD STATE\nparty_gold: 12\nparty_position: east_door\ntorch: 4 hours\nnpc_mood: suspicious\n'


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
    body.append(STATE)
    # two probe markers baked deep into the prefix, so an edit can be placed at a chosen depth
    s = ''.join(body)
    s = s[:int(len(s) * 0.40)] + '\nMARK_40 = 7\n' + s[int(len(s) * 0.40):]
    s = s[:int(len(s) * 0.90)] + '\nMARK_90 = 7\n' + s[int(len(s) * 0.90):]
    return s


def call(system, user, max_tokens=12):
    body = json.dumps({'model': MODEL,
                       'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
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


def edit_at(s, needle, val):
    return s.replace(needle, needle.replace('7', val), 1)


def main():
    power = os.popen('powercfg -getactivescheme').read().strip().split('(')[-1].rstrip(')')
    print('power: %s   ctx target: %d   model: %s' % (power, SIZE, os.path.basename(MODEL)), flush=True)
    prefix = build(SIZE)
    res = {'at': datetime.datetime.now().isoformat(), 'power': power, 'size': SIZE, 'cases': []}
    print('%-14s %8s %8s %8s %10s' % ('case', 'ptok', 'ttft', 'total', 'ptok/s'), flush=True)

    def run(case, sysmsg, user='What now?', maxtok=12):
        r = call(sysmsg, user, maxtok)
        r['case'] = case
        res['cases'].append(r)
        print('%-14s %8s %8s %8s %10s' % (case, r['ptok'], r['ttft'], r['total'], r['eval_rate']), flush=True)
        return r

    run('cold', prefix)
    run('warm', prefix)
    run('append_turn', prefix, 'And now? new round please')
    run('state_40pct', edit_at(prefix, '\nMARK_40 = 7\n', '\nMARK_40 = 8\n'))
    run('state_90pct', edit_at(prefix, '\nMARK_90 = 7\n', '\nMARK_90 = 8\n'))
    run('state_head', 'X' + prefix[1:])
    print('  idle %ds (the party is arguing about a door)...' % IDLE_SEC, flush=True)
    time.sleep(IDLE_SEC)
    run('idle_then_turn', prefix, 'And now? new round please')
    run('again_state_40', edit_at(prefix, '\nMARK_40 = 7\n', '\nMARK_40 = 9\n'))
    run('again_state_40b', edit_at(prefix, '\nMARK_40 = 7\n', '\nMARK_40 = 10\n'))

    d = {c['case']: c for c in res['cases']}
    print('\n=== verdict at %d prompt tokens ===' % (d.get('warm', {}).get('ptok') or SIZE))
    for k in ('append_turn', 'state_40pct', 'state_90pct', 'state_head', 'idle_then_turn'):
        if k in d and d.get('cold'):
            c, x = d['cold'], d[k]
            print('  %-16s %6.2fs vs cold %6.2fs  -> %s' % (k, x['ttft'], c['ttft'],
                  'cheaper than cold' if x['ttft'] < c['ttft'] else 'WORSE THAN COLD'))
    json.dump(res, open(OUT, 'w'), indent=1)
    print('wrote', OUT)


main()
