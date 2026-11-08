#!/usr/bin/env python3
"""Probe D: does the prompt cache survive a game-length context, and does it survive being idle?

The architecture doc calls turn latency the #1 risk, and the game's turn shape is: one long prompt
(rules + world state + transcript) that grows by a few hundred tokens per round, sent again and again.
So the question is not "what is TTFT" but "how much of the prompt do we re-evaluate per turn".

This model is hybrid (DeltaNet / recurrent layers mixed with attention). Whether the recurrent state
lands in the prompt cache with the attention KV is exactly the thing nobody has measured, and it is a
cliff: if it does not, every round pays a full ~16K prompt eval.

Cases, per prefix size, in this order (each one changes the cache, so order is part of the method):
  cold            first sight of the prefix, empty cache
  warm_same       byte-identical prompt again
  warm_plus_turn  same prefix + one new user turn  <- the actual game pattern
  warm_grow       prefix grown by ~1.5K, as history grows each round
  warm_edit_head  one character changed near the start - worst case, models a state edit
  idle_90s        90 seconds of nothing, then the game pattern again. Players talk longer than that.

Read TTFT, not throughput: the game is judged by time-to-first-audio. `reuse` is prompt tokens divided
by (TTFT in seconds); a number near the machine's prompt-eval rate means no cache help, a number in the
tens of thousands means the prefix was genuinely reused.
"""
import json, time, urllib.request, statistics, sys, os, datetime

URL = 'http://127.0.0.1:8080/v1/chat/completions'
MODEL_PATH = r'C:\dm\models\Hermes3.6-35B-A3B-MTP-MXFP4exp-Q4K_S.gguf'
RULES = r'C:\Users\jommy\Documents\Dungeon-Blaster\rules\rules.md'
OUT = r'C:\Users\jommy\Documents\Dungeon-Blaster\notes\probe-d-results.json'

SYSTEM = (
    'You are the Dungeon Master of Dungeon Blaster. The deterministic tracker is the source of truth; you '
    'are a narrator with a vote, not a referee. Emit exactly one resolve_round tool call per round. Never '
    'invent materials, tiers, inventory, or positions. Read the rulebook below as law.\n\nRULEBOOK:\n'
)
FILLER = (
    'Round recap: the party argued about a door, a goblin survived an unlucky round, somebody looted a '
    'cracked brazier, the torch burned down another inch, the cartographer insisted the map was a lie, '
    'and theDM described the smell as wet pennies and old jam. '
)


RUN_NONCE = 'run %s ' % datetime.datetime.now().strftime('%H%M%S%f')   # otherwise "cold" means "already cached"


def build(n_target_tokens, seed=0):
    """Deterministic prefix. Token count is verified by the server, not estimated."""
    if os.path.exists(RULES):
        rules = open(RULES, encoding='utf-8').read()[:6000]
    else:
        rules = 'rule sections: xp.curve tier.table craft.gate materials budget\n'
    body = [SYSTEM, rules, '\n\nTRANSCRIPT:\n']
    i = seed
    while True:
        body.append('[%d] player: we try the door. dm: %s\n' % (i, FILLER))
        i += 1
        s = ''.join(body)
        if len(s) / 3.6 >= n_target_tokens:      # rough; server reports the truth
            return s
        if i > 3000:
            return s


def call_multi(system, msgs, max_tokens=8):
    return call(system, '', max_tokens, msgs)


def call(system, user, max_tokens=8, msgs=None):
    body = json.dumps({
        'model': MODEL_PATH,
        'messages': [{'role': 'system', 'content': system}] + (msgs or [{'role': 'user', 'content': user}]),
        'max_tokens': max_tokens, 'temperature': 0.2, 'stream': True,
        'stream_options': {'include_usage': True},   # without this, usage is absent and ptok is silently None
        'chat_template_kwargs': {'enable_thinking': False},
    }).encode()
    req = urllib.request.Request(URL, data=body, headers={'Content-Type': 'application/json'})
    t0 = time.perf_counter()
    ttft = None
    ptok = ctok = None
    timings = {}
    with urllib.request.urlopen(req, timeout=600) as r:
        for raw in r:
            line = raw.decode('utf-8', 'replace').strip()
            if not line.startswith('data: '):
                continue
            payload = line[6:]
            if payload == '[DONE]':
                break
            try:
                d = json.loads(payload)
            except Exception:
                continue
            if ttft is None and d.get('choices') and (d['choices'][0].get('delta', {}).get('content')
                                                      or d['choices'][0].get('delta', {}).get('tool_calls')):
                ttft = time.perf_counter() - t0
            u = d.get('usage') or {}
            ptok = u.get('prompt_tokens', ptok)
            ctok = u.get('completion_tokens', ctok)
            if d.get('timings'):
                timings = d['timings']
    total = time.perf_counter() - t0
    if ttft is None:
        ttft = total
    return {'ttft': round(ttft, 3), 'total': round(total, 3), 'ptok': ptok, 'ctok': ctok,
            'tok_per_s': round((ctok or 0) / total, 2) if total else None,
            'prompt_tok_per_s': round(ptok / ttft) if ttft and ptok else None,
            'srv': timings}


def main():
    power = os.popen('powercfg -getactivescheme').read().strip().split('(')[-1].rstrip(')')
    print('power scheme:', power)
    print('model      :', MODEL_PATH)
    health = json.load(urllib.request.urlopen('http://127.0.0.1:8080/props', timeout=10))
    print('ctx        :', health.get('n_ctx') or health.get('total_tokens') or 'unknown')
    res = {'at': datetime.datetime.now().isoformat(), 'power': power, 'cases': []}
    hdr = '%-9s %-14s %8s %7s %7s %8s %9s' % ('size', 'case', 'ptok', 'ttft', 'total', 'tok/s', 'ptok/s')
    sizes = [int(x) for x in os.environ.get('SIZES', '2000,8000,16000,20000').split(',')]
    for size in sizes:
        prefix = build(size)
        print('\n=== target ~%d tokens ===' % size)
        print(hdr)
        runs = []
        for case, user in (
            ('cold', 'What do the party see?'),
            ('warm_same', 'What do the party see?'),
            ('warm_plus_turn', 'And now? (new round, same rules and history)'),
            ('idle_90s', 'And now?'),       # must follow the game pattern directly, with nothing destructive between
            ('grow_by_turn', ''),           # expanded inline below into _1/_2/_3
            ('grow_in_system', None),        # history appended INSIDE the system block
            ('warm_edit_head', 'What do the party see?'),   # invalidates the prefix: last, on purpose
        ):
            sysmsg = prefix
            u = user
            if case == 'warm_grow':
                sysmsg = prefix + FILLER * 14 + '\n'
                u = 'And now?'
            if case == 'warm_edit_head':
                sysmsg = 'X' + prefix[1:]
            if case == 'idle_90s':
                print('  sleeping 90s (players arguing about the door)...', flush=True)
                time.sleep(90)

            if case == 'grow_by_turn':
                for step in range(1, 4):
                    hist = []
                    for k in range(step):
                        hist += [{'role': 'user', 'content': 'round %d: we try the door (%s)' % (k, FILLER[:40])},
                                 {'role': 'assistant', 'content': 'round %d: the door resists, wet pennies hang in the air.' % k}]
                    hist.append({'role': 'user', 'content': 'And now?'})
                    r = call_multi(prefix, hist)
                    r.update(size=size, case='grow_by_turn_%d' % step)
                    res['cases'].append(r)
                    print('%-9s %-14s %8s %7s %7s %8s %9s' % (size, r['case'], r['ptok'], r['ttft'], r['total'],
                                                              r['tok_per_s'], r['prompt_tok_per_s']))
                    sys.stdout.flush()
                continue
            r = call(sysmsg, u)
            r['size'] = size
            r['case'] = case
            runs.append(r)
            res['cases'].append(r)
            print('%-9s %-14s %8s %7s %7s %8s %9s' % (size, case, r['ptok'], r['ttft'], r['total'],
                                                       r['tok_per_s'], r['prompt_tok_per_s']))
            sys.stdout.flush()
    cold = [c for c in res['cases'] if c['case'] == 'cold']
    warm = [c for c in res['cases'] if c['case'] == 'warm_plus_turn']
    wu = [c for c in res['cases'] if c['case'] == 'warmup']
    print('  first request ever: %s s at %s prompt tokens (one-off setup, excluded from cold)'
          % (wu[0]['ttft'] if wu else '?', wu[0]['ptok'] if wu else '?'))
    print('\n=== verdict ===')
    for c, w in zip(cold, warm):
        if c['ttft'] and w['ttft']:
            print('  %-6s cold %5.2fs -> game-pattern warm %5.2fs   (%.1fx) reuse %s -> %s tok/s evaluated'
                  % (c['size'], c['ttft'], w['ttft'], c['ttft'] / w['ttft'], c['prompt_tok_per_s'], w['prompt_tok_per_s']))
        idle = [c for c in res['cases'] if c['size'] == c['size'] and c['case'] == 'idle_90s' and c['size'] == w['size']]
        if idle:
            i = idle[0]
            print('         after 90s idle: ttft %5.2fs  (%s%% of warm) -> %s'
                  % (i['ttft'], int(100 * i['ttft'] / w['ttft']) if w['ttft'] else '?',
                     'cache survived' if w['ttft'] and i['ttft'] < 1.6 * w['ttft'] else 'CACHE LOST'))
    json.dump(res, open(OUT, 'w'), indent=1)
    print('\nwrote', OUT)


main()
