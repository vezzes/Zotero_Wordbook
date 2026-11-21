#!/usr/bin/env python3
"""Builds the plugin's built-in data (run by the developer; not needed by the user).

  python3 tools/build_data.py <openrussian_csv_dir> <wordnet_dict_dir>

Sources:
  • OpenRussian (https://github.com/Badestrand/russian-dictionary), CC BY-SA 4.0 — from it,
    by "inverting" it (English meaning -> Russian word), the EN→RU dictionary is built.
  • WordNet 3.1 (npm: wordnet-db), Princeton University licence — multi-word
    expressions for recognising phrasal verbs and idioms.
  • tools/idioms-curated.tsv — hand-curated list of common expressions with Russian equivalents.

Output: content/data/dict-basic.json, content/data/idioms.json
"""
import csv, json, os, re, sys, collections

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'content', 'data')
csv.field_size_limit(10**9)

def build_dict(src):
    index = collections.defaultdict(list)  # en -> [(score, ru)]
    files = [('nouns.csv', 0), ('verbs.csv', 1), ('adjectives.csv', 2), ('others.csv', 3)]
    for fn, _ in files:
        with open(os.path.join(src, fn), encoding='utf-8', newline='') as f:
            rows = list(csv.DictReader(f, delimiter='\t'))
        n = max(len(rows), 1)
        for i, row in enumerate(rows):
            ru = (row.get('bare') or '').strip()
            en = (row.get('translations_en') or '').strip()
            if not ru or not en:
                continue
            ru = ru.replace('*', '')
            partner = re.split(r'[;,]', row.get('partner') or '')[0].strip().replace('*', '')
            if partner in ('-', '—'):
                partner = ''
            ru = re.split(r'[;,]', ru)[0].strip()
            label = f'{ru} / {partner}' if fn == 'verbs.csv' and partner else ru
            norm = i / n  # order in the file ≈ frequency
            parts = [p.strip() for p in re.split(r'[;,]', en)]
            for pos, p in enumerate(parts):
                p = re.sub(r'\([^)]*\)', '', p).strip().lower()
                p = re.sub(r'^(to|a|an|the)\s+', '', p)
                p = re.sub(r'\s+', ' ', p)
                if not p or len(p) > 40 or not re.search('[a-z]', p) or re.search(r'[^a-z \'-]', p):
                    continue
                index[p].append((norm + 0.08 * pos, label, partner))
    out = {}
    for key, items in index.items():
        items.sort(key=lambda x: x[0])
        seen, res = set(), []
        for _, label, partner in items:
            base = label.split(' / ')[0]
            if base in seen or label in seen:
                continue
            seen.add(base); seen.add(label)
            if partner:
                seen.add(partner)  # the aspect partner is already shown on the same line
            res.append(label)
            if len(res) >= 7:
                break
        out[key] = '|'.join(res)
    return out

def build_idioms(wn_dir, curated_path):
    ids = {}
    # WordNet: multi-word, no proper nouns
    for pos, fn in (('n', 'data.noun'), ('v', 'data.verb'), ('a', 'data.adj'), ('r', 'data.adv')):
        with open(os.path.join(wn_dir, fn), encoding='utf-8') as f:
            for line in f:
                if line.startswith('  '):
                    continue
                head, _, gloss = line.partition('|')
                t = head.split()
                wcnt = int(t[3], 16)
                gloss = gloss.strip().split(';')[0].strip()
                for i in range(wcnt):
                    w = re.sub(r'\(\w+\)$', '', t[4 + 2 * i])
                    if '_' not in w or w != w.lower():
                        continue
                    key = w.replace('_', ' ')
                    if len(key.split()) > 7 or re.search(r'[^a-z \'-]', key):
                        continue
                    code = {'n': 'n', 'v': 'v', 'a': 'x', 'r': 'x'}[pos]
                    if key in ids:
                        continue
                    ids[key] = [code, '', '' if pos == 'n' else gloss]
    # hand-curated list: overrides WordNet
    code_by_type = {'идиома': 'i', 'фразовый глагол': 'p', 'устойчивое выражение': 'x', 'пословица': 's'}
    with open(curated_path, encoding='utf-8') as f:
        for line in f:
            if not line.strip() or line.startswith('#'):
                continue
            parts = line.rstrip('\n').split('\t')
            if len(parts) != 3:
                raise SystemExit('Malformed line in idioms-curated.tsv: ' + line)
            key, typ, ru = (p.strip() for p in parts)
            if typ not in code_by_type:
                raise SystemExit('Unknown type: ' + typ)
            old = ids.get(key)
            ids[key] = [code_by_type[typ], ru, old[2] if old else '']
    return ids

if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    os.makedirs(OUT, exist_ok=True)
    d = build_dict(sys.argv[1])
    json.dump(d, open(os.path.join(OUT, 'dict-basic.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    ids = build_idioms(sys.argv[2], os.path.join(HERE, 'idioms-curated.tsv'))
    json.dump(ids, open(os.path.join(OUT, 'idioms.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('dict-basic:', len(d), 'keys;', 'idioms:', len(ids), 'expressions')
