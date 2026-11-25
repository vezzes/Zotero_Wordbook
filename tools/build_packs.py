#!/usr/bin/env python3
"""Builds the offline dictionary packs that users download in the plugin (Settings → Wordbook → «Офлайн-словари»).

  python3 tools/build_packs.py --out dist-packs [--only en-ru,ru-en] [--cache .cache-packs]

Writes <out>/<src>-<dst>.json for every pack that could be built, plus <out>/catalog.json.
Upload all of them to the GitHub release with the tag «dictionaries» (done by .github/workflows/build-dictionaries.yml).

Pack file format and catalog format: see content/packs.js.
Value format of "entries":  "translation 1|translation 2|…"   (key: lowercase headword)
  "→headword"          — the key is an inflected form of the headword (the translation is taken from the headword)
  "~reading|…"         — an item starting with "~" is a reading (pinyin), shown before the translations

Sources (all downloaded at build time; nothing here is bundled in the plugin):
  en-ru       packs-src/en-ru (built by tools/build_data.py from OpenRussian + WordNet + curated idioms)
  ru-en ru-de de-ru   OpenRussian (CC BY-SA 4.0) https://github.com/Badestrand/russian-dictionary
  zh-en en-zh         CC-CEDICT (CC BY-SA 4.0) https://cc-cedict.org  — taken from the npm package «cc-cedict»
  other pairs         FreeDict (GPL / CC, per dictionary) https://freedict.org — the release database, otherwise
                      the TEI sources in https://github.com/freedict/fd-dictionaries
"""
import argparse, collections, csv, datetime, hashlib, io, json, os, re, subprocess, sys, tarfile, unicodedata, urllib.request
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
LANGS = ['en', 'zh', 'de', 'fr', 'es', 'pt', 'ru']
ISO3 = {'en': 'eng', 'de': 'deu', 'fr': 'fra', 'es': 'spa', 'pt': 'por', 'ru': 'rus', 'zh': 'zho'}
NAMES = {'en': 'Английский', 'zh': 'Китайский', 'de': 'Немецкий', 'fr': 'Французский', 'es': 'Испанский', 'pt': 'Португальский', 'ru': 'Русский'}
MAX_ITEMS = 8
csv.field_size_limit(10**9)


# ---------------------------------------------------------------- helpers
def fetch(url, dest, cache):
    path = os.path.join(cache, dest)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    print('  download', url, file=sys.stderr)
    req = urllib.request.Request(url, headers={'User-Agent': 'zotero-wordbook-build'})
    with urllib.request.urlopen(req, timeout=180) as r, open(path, 'wb') as f:
        f.write(r.read())
    return path


def clean_item(s, keep_parens=False):
    s = re.sub(r'\s+', ' ', s).strip()
    if not keep_parens:
        s = re.sub(r'\s*[\(\[][^)\]]*[\)\]]', '', s).strip()
    return s


def add_item(lst, item):
    item = item.strip().strip(',;')
    if item and '|' not in item and item not in lst and len(item) <= 80:
        lst.append(item)


def strip_accents(s):
    return s.replace("'", '').replace('́', '')


INVERTED_NOTE = 'Обратный словарь, собранный автоматически: варианты перевода могут быть неточными.'


def pack_meta(src, dst, entries, source, license_, extra=None):
    obj = {
        'format': 1,
        'id': f'{src}-{dst}',
        'src': src,
        'dst': dst,
        'name': f'{NAMES[src]} → {NAMES[dst]}',
        'version': datetime.date.today().isoformat(),
        'source': source,
        'license': license_,
        'entries': entries,
    }
    if extra:
        obj.update(extra)
    return obj


# ---------------------------------------------------------------- en-ru (existing data)
def build_en_ru(a):
    d = os.path.join(ROOT, 'packs-src', 'en-ru')
    entries = json.load(open(os.path.join(d, 'dict-basic.json'), encoding='utf-8'))
    idioms = json.load(open(os.path.join(d, 'idioms.json'), encoding='utf-8'))
    return pack_meta('en', 'ru', entries, 'OpenRussian (inverted), WordNet 3.1, curated idioms', 'CC BY-SA 4.0 / WordNet License', {'idioms': idioms, 'note': 'Включает базу идиом и фразовых глаголов.'})


# ---------------------------------------------------------------- OpenRussian: ru-en, ru-de, de-ru
OR_FILES = ['nouns', 'verbs', 'adjectives', 'others']
OR_URL = 'https://raw.githubusercontent.com/Badestrand/russian-dictionary/master/%s.csv'
FORM_COLS = {
    'nouns': ['sg_nom', 'sg_gen', 'sg_dat', 'sg_acc', 'sg_inst', 'sg_prep', 'pl_nom', 'pl_gen', 'pl_dat', 'pl_acc', 'pl_inst', 'pl_prep'],
    'verbs': ['imperative_sg', 'imperative_pl', 'past_m', 'past_f', 'past_n', 'past_pl', 'presfut_sg1', 'presfut_sg2', 'presfut_sg3', 'presfut_pl1', 'presfut_pl2', 'presfut_pl3'],
    'adjectives': ['comparative', 'superlative', 'short_m', 'short_f', 'short_n', 'short_pl'] + [f'decl_{g}_{c}' for g in ('m', 'f', 'n', 'pl') for c in ('nom', 'gen', 'dat', 'acc', 'inst', 'prep')],
    'others': [],
}
FORMS_PER_FILE = 6000  # inflected forms are added only for the most frequent words of each file (the file order ≈ frequency)


def openrussian_rows(cache):
    for fn in OR_FILES:
        path = fetch(OR_URL % fn, f'openrussian/{fn}.csv', cache)
        with open(path, encoding='utf-8', newline='') as f:
            rows = list(csv.DictReader(f, delimiter='\t'))
        for i, row in enumerate(rows):
            yield fn, i, len(rows), row


def split_tr(s):
    out = []
    for p in re.split(r'[;,]', s or ''):
        p = clean_item(p, keep_parens=True)
        if p:
            add_item(out, p)
    return out


def build_ru_x(cache, col, dst):
    entries = {}
    forms = {}
    for fn, i, n, row in openrussian_rows(cache):
        bare = strip_accents((row.get('bare') or '').strip().lower().replace('*', ''))
        items = split_tr(row.get(col))
        if not bare or not items:
            continue
        if bare in entries:
            for it in items:
                if len(entries[bare]) < MAX_ITEMS:
                    add_item(entries[bare], it)
        else:
            entries[bare] = items[:MAX_ITEMS]
        if fn in FORM_COLS and i < FORMS_PER_FILE:
            for c in FORM_COLS[fn]:
                for form in re.split(r'[;,]', row.get(c) or ''):
                    form = strip_accents(form.strip().lower())
                    if form and form != bare and ' ' not in form and form not in forms:
                        forms[form] = bare
    out = {k: '|'.join(v) for k, v in entries.items()}
    for form, bare in forms.items():
        if form not in out:
            out[form] = '→' + bare
    return pack_meta('ru', dst, out, 'OpenRussian (https://en.openrussian.org)', 'CC BY-SA 4.0')


def build_x_ru(cache, col, src):
    """Inverts OpenRussian: a foreign word -> Russian words (the file order ≈ frequency)."""
    index = collections.defaultdict(list)
    for fn, i, n, row in openrussian_rows(cache):
        ru = re.split(r'[;,]', strip_accents((row.get('bare') or '').strip().replace('*', '')))[0].strip()
        if not ru:
            continue
        partner = strip_accents(re.split(r'[;,]', row.get('partner') or '')[0].strip().replace('*', ''))
        if partner in ('-', '—'):
            partner = ''
        label = f'{ru} / {partner}' if fn == 'verbs' and partner else ru
        norm = i / max(n, 1)
        for pos, p in enumerate(re.split(r'[;,]', row.get(col) or '')):
            p = clean_item(p).lower()
            if src == 'en':
                p = re.sub(r'^(to|a|an|the)\s+', '', p)
            elif src == 'de':
                p = re.sub(r'^(der|die|das|ein|eine|sich)\s+', '', p)
            if not p or len(p) > 40 or re.search(r'[\d/]', p):
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
            seen.add(base)
            seen.add(label)
            if partner:
                seen.add(partner)
            res.append(label)
            if len(res) >= 7:
                break
        out[key] = '|'.join(res)
    return pack_meta(src, 'ru', out, 'OpenRussian (inverted)', 'CC BY-SA 4.0', {'note': INVERTED_NOTE})


# ---------------------------------------------------------------- CC-CEDICT: zh-en, en-zh
TONE = {'a': 'āáǎà', 'e': 'ēéěè', 'i': 'īíǐì', 'o': 'ōóǒò', 'u': 'ūúǔù', 'ü': 'ǖǘǚǜ'}


def pinyin_syllable(s):
    m = re.match(r'^([A-Za-züÜ:]+?)([1-5])$', s)
    if not m:
        return s
    w, t = m.group(1).replace('u:', 'ü').replace('U:', 'Ü'), int(m.group(2))
    if t == 5:
        return w
    low = w.lower()
    pos = None
    if 'a' in low:
        pos = low.index('a')
    elif 'e' in low:
        pos = low.index('e')
    elif 'ou' in low:
        pos = low.index('ou')
    else:
        for k in range(len(low) - 1, -1, -1):
            if low[k] in 'iouü':
                pos = k
                break
    if pos is None:
        return w
    ch = low[pos]
    marked = TONE[ch][t - 1]
    return w[:pos] + (marked.upper() if w[pos].isupper() else marked) + w[pos + 1:]


def pinyin(s):
    return ' '.join(pinyin_syllable(x) for x in s.split())


def cedict_rows(cache):
    """-> [(traditional, simplified, pinyin_numbered, [definitions])] from the npm package «cc-cedict»."""
    d = os.path.join(cache, 'cc-cedict')
    js = os.path.join(d, 'package', 'data', 'all.js')
    if not os.path.exists(js):
        os.makedirs(d, exist_ok=True)
        print('  npm pack cc-cedict', file=sys.stderr)
        subprocess.run(['npm', 'pack', 'cc-cedict', '--silent'], cwd=d, check=True)
        tgz = [f for f in os.listdir(d) if f.endswith('.tgz')][0]
        with tarfile.open(os.path.join(d, tgz)) as t:
            t.extractall(d)
    text = open(js, encoding='utf-8').read()
    data = json.loads(text[text.index('{'):text.rindex('}') + 1])['all']
    rows = []
    for r in data:
        trad, simp, py, defs = r[0], r[1], r[2], r[3]
        if isinstance(defs, str):
            defs = [defs]
        defs = [x for x in defs if x and not x.startswith('CL:')]
        rows.append((trad, simp, py, defs))
    return rows


def clean_def(d):
    d = re.sub(r'\s*\((?:[^()]|\([^()]*\))*\)', '', d).strip()  # remove (comments)
    d = re.sub(r'^(variant of|see also|see|also written|abbr\. for|old variant of|erhua variant of|CL:).*$', '', d, flags=re.I)
    return d.strip()


def build_zh_en(cache):
    out = {}
    for trad, simp, py, defs in cedict_rows(cache):
        items = []
        add_item(items, '~' + pinyin(py))
        n = 0
        for d in defs:
            for c in re.split(r';\s*', clean_def(d)):
                c = c.strip()
                if c and n < MAX_ITEMS - 1:
                    add_item(items, c)
                    n += 1
        if len(items) < 2:
            continue
        val = '|'.join(items)
        for key in {simp, trad}:
            key = key.strip()
            if key in out:
                if val not in out[key].split('\n'):
                    out[key] = out[key]  # the first entry wins; the other readings are merged below
                continue
            out[key] = val
    return pack_meta('zh', 'en', out, 'CC-CEDICT (https://cc-cedict.org)', 'CC BY-SA 4.0')


def build_en_zh(cache):
    index = collections.defaultdict(list)
    for trad, simp, py, defs in cedict_rows(cache):
        for pos, d in enumerate(defs[:6]):
            c = clean_def(d).lower()
            c = re.sub(r'^(to|a|an|the)\s+', '', c)
            if not c or len(c) > 40 or re.search(r'[^a-z \'-]', c):
                continue
            index[c].append((pos, len(simp), f'{simp} {pinyin(py)}'))
    out = {}
    for key, items in index.items():
        items.sort()
        res = []
        for _, _, label in items:
            if label.lower() not in [r.lower() for r in res]:
                res.append(label)
            if len(res) >= 6:
                break
        out[key] = '|'.join(res)
    return pack_meta('en', 'zh', out, 'CC-CEDICT (inverted)', 'CC BY-SA 4.0', {'note': INVERTED_NOTE + ' Китайские слова даны с пиньинь.'})


# ---------------------------------------------------------------- FreeDict
FD_DB = 'https://freedict.org/freedict-database.json'
FD_RAW = 'https://raw.githubusercontent.com/freedict/fd-dictionaries/master/%s/%s.tei'


def tei_to_entries(stream):
    entries = {}
    ns = ''
    for ev, el in ET.iterparse(stream, events=('end',)):
        tag = el.tag.rsplit('}', 1)[-1]
        if tag != 'entry':
            continue
        orth = None
        for o in el.iter():
            if o.tag.rsplit('}', 1)[-1] == 'orth' and (o.text or '').strip():
                orth = o.text.strip()
                break
        trans = []
        for q in el.iter():
            if q.tag.rsplit('}', 1)[-1] == 'quote' and (q.text or '').strip():
                add_item(trans, clean_item(q.text, keep_parens=True))
        el.clear()
        if not orth or not trans:
            continue
        key = unicodedata.normalize('NFKC', clean_item(orth)).lower()
        if not key or len(key) > 60:
            continue
        cur = entries.setdefault(key, [])
        for t in trans:
            if len(cur) < MAX_ITEMS:
                add_item(cur, t)
    return {k: '|'.join(v) for k, v in entries.items() if v}


def freedict_license(tei_head):
    m = re.search(r'Available under the terms of the.*?>([^<]+)</ref>', tei_head, re.S)
    return (m.group(1).strip() if m else 'see FreeDict').replace('\n', ' ')


def build_freedict(src, dst, cache):
    pair = f'{ISO3[src]}-{ISO3[dst]}'
    # 1. the release database of FreeDict (larger dictionaries), if it lists the pair
    try:
        db = json.load(open(fetch(FD_DB, 'freedict-database.json', cache), encoding='utf-8'))
        rec = next((x for x in db if x.get('name') == pair), None)
        url = None
        for r in (rec or {}).get('releases', []):
            if r.get('platform') == 'src':
                url = r.get('URL')
        if url:
            path = fetch(url, f'freedict/{pair}.src.tar.xz', cache)
            with tarfile.open(path) as t:
                member = next(m for m in t.getmembers() if m.name.endswith(f'{pair}.tei'))
                data = t.extractfile(member).read()
            head = data[:6000].decode('utf-8', 'ignore')
            return pack_meta(src, dst, tei_to_entries(io.BytesIO(data)), f'FreeDict {pair}', freedict_license(head))
    except Exception as e:
        print(f'  FreeDict database: {pair}: {e}', file=sys.stderr)
    # 2. the TEI source in the GitHub repository
    try:
        path = fetch(FD_RAW % (pair, pair), f'freedict/{pair}.tei', cache)
    except Exception as e:
        print(f'  FreeDict: no {pair}: {e}', file=sys.stderr)
        return None
    head = open(path, encoding='utf-8').read(6000)
    with open(path, 'rb') as f:
        return pack_meta(src, dst, tei_to_entries(f), f'FreeDict {pair}', freedict_license(head))


# ---------------------------------------------------------------- main
def builder_for(pid, cache):
    src, dst = pid.split('-')
    if pid == 'en-ru':
        return lambda: build_en_ru(None)
    if pid == 'ru-en':
        return lambda: build_ru_x(cache, 'translations_en', 'en')
    if pid == 'ru-de':
        return lambda: build_ru_x(cache, 'translations_de', 'de')
    if pid == 'de-ru':
        return lambda: build_x_ru(cache, 'translations_de', 'de')
    if pid == 'zh-en':
        return lambda: build_zh_en(cache)
    if pid == 'en-zh':
        return lambda: build_en_zh(cache)
    if 'zh' in (src, dst) or 'ru' in (src, dst):
        return None  # no source
    return lambda: build_freedict(src, dst, cache)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'dist-packs'))
    ap.add_argument('--cache', default=os.path.join(ROOT, '.cache-packs'))
    ap.add_argument('--only', default='')
    ap.add_argument('--min-entries', type=int, default=500)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    want = [x for x in a.only.split(',') if x] or [f'{s}-{d}' for s in LANGS for d in LANGS if s != d]
    catalog = []
    for pid in want:
        b = builder_for(pid, a.cache)
        if not b:
            continue
        print('==', pid, file=sys.stderr)
        try:
            obj = b()
        except Exception as e:
            print(f'  FAILED {pid}: {e}', file=sys.stderr)
            continue
        if not obj or len(obj['entries']) < a.min_entries:
            print(f'  skipped {pid}: too few entries', file=sys.stderr)
            continue
        data = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        fn = pid + '.json'
        open(os.path.join(a.out, fn), 'wb').write(data)
        catalog.append({
            'id': pid, 'src': obj['src'], 'dst': obj['dst'], 'name': obj['name'], 'file': fn, 'size': len(data),
            'entries': len(obj['entries']), 'sha256': hashlib.sha256(data).hexdigest(), 'version': obj['version'],
            'license': obj['license'], 'source': obj['source'], 'note': obj.get('note', ''),
        })
        print(f'  {pid}: {len(obj["entries"])} entries, {len(data) / 1e6:.1f} MB', file=sys.stderr)
    json.dump({'format': 1, 'updated': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'packs': catalog},
              open(os.path.join(a.out, 'catalog.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('catalog:', ', '.join(c['id'] for c in catalog))


if __name__ == '__main__':
    main()
