# Zotero Wordbook — architecture and developer notes

A plugin for Zotero 7+ (tested on 10.0.8): a personal English-Russian vocabulary builder right inside the PDF reader. PDF only. The plugin interface inside Zotero (menus, popups, settings) is in Russian; Russian labels are quoted below with English glosses.

1. Select a word or phrase → the popup shows a translation and an «＋ В словарь» (add to dictionary) button.
2. Words from the dictionary are highlighted in **all** open books; hovering shows the translation instantly.
3. Export the dictionary to Anki without duplicates (via AnkiConnect, with TSV as a fallback).

> The plugin was tested on Zotero 10.0.8 (Windows). The places that depend on undocumented parts of the reader are listed in the "Risks" section.

## Diagram

```
                         Zotero 10 (process)
 ┌──────────────────────────────────────────────────────────────────┐
 │ bootstrap.js  — lifecycle: startup / shutdown / windows          │
 │      │ loads content/*.js into a shared scope, creates Wordbook  │
 │      ▼                                                           │
 │ wordbook.js (core: prefs, events, normalize, utilities)          │
 │      │                                                           │
 │      ├── store.js ────────────► <DataDir>/wordbook/words.json    │
 │      │      ▲   │ "words-changed"                                │
 │      │      │   ▼                                                │
 │      ├── highlighter.js  (highlight + tooltip in the book DOM)   │
 │      │      ▲                                                    │
 │      ├── reader.js ◄──── Zotero.Reader.registerEventListener     │
 │      │      │  (selection popup, reader opened)                  │
 │      │      └──► translator.js ─┬─► dict.js + lemma.js (offline) │
 │      │                          ├─► idioms.js (idioms, offline)  │
 │      │                          └─► Gemini / DeepSeek (online)   │
 │      │                                                           │
 │      ├── anki.js ──► AnkiConnect (127.0.0.1:8765) | TSV file     │
 │      └── ui.js  ──► "Tools" menu                                 │
 └──────────────────────────────────────────────────────────────────┘
```

Dependencies are one-directional: `reader` and `ui` know about `store`, `translator` and `anki`; `store` knows nothing about the UI and reports changes with a `words-changed` event, which `highlighter` subscribes to.

## Modules

| File | Responsibility |
|---|---|
| `manifest.json`, `bootstrap.js`, `prefs.js` | Manifest (WebExtension style), lifecycle, default preference values |
| `content/wordbook.js` | The global `Wordbook` object: preferences, event bus, `normalize()`, `stems()`, `debounce()` |
| `content/store.js` | The dictionary: `add / update / remove / lookup / pendingAnki / markExported`, atomic JSON saving |
| `packs-src/`, `licenses/` | Sources of the en-ru pack and the license texts (not in the .xpi). Formerly bundled data: `dict-basic.json` (EN→RU dictionary, ~44k words), `idioms.json` (~39k expressions) and the license texts |
| `content/packs.js` | Offline dictionary packs: catalog, download with a checksum, storage in `<data dir>/wordbook/packs/`, loading of the current pair (`Wordbook.Packs`); lookup in a generic pack (`Wordbook.PackDict`) |
| `content/dict.js` | The English → Russian dictionary logic (from the `en-ru` pack) plus (optionally) a loaded StarDict; word and expression lookup |
| `content/morph.js`, `content/lib/snowball.js` | Morphology for en/ru: words are reduced to stems (Snowball stemmers, ISC), and words and expressions are compared by stems; used in highlighting, entry lookup and context masking |
| `content/lemma.js` | Reduces English word forms to the base form (rules + a table of irregular forms) |
| `content/idioms.js` | Recognises idioms, phrasal verbs and fixed expressions in the selection and in the sentence |
| `content/translator.js` | `offline(text)` — instant, no network; `online(text, context)` — Google Translate (default), Gemini or an OpenAI-compatible service |
| `content/reader.js` | The selection popup (translation, alternatives, button), the 📖 button in the reader toolbar, hooking up highlighting |
| `content/pdf-text.js` | Page text built from Zotero's characters (joining hyphenated line breaks, ligatures), match rectangles per line, the context sentence |
| `content/highlighter.js` | A regex built from the dictionary, an overlay layer on top of the PDF pages, the hover tooltip |
| `content/dictionary.xhtml/.js` | The dictionary window: search, editing the translation, deleting, jumping to the book, export |
| `content/anki.js` | AnkiConnect: creating the deck/note type, `addNotes`, duplicate lookup; TSV export |
| `content/ui.js` | The "Tools" menu items and opening the dictionary window |
| `content/preferences.xhtml/.js` | The settings pane: online translation (service, key, test), highlight colour, Anki |
| `tools/build_data.py`, `tools/build_packs.py`, `tools/idioms-curated.tsv` | Building the en-ru source data and all dictionary packs; the author's list of idioms and fixed expressions |

## Data model

A single file, `<Zotero data directory>/wordbook/words.json`:

```json
{ "version": 1, "words": [
  { "id": "uuid", "key": "carry out", "text": "Carry out",
    "translation": "выполнять", "context": "",
    "source": { "libraryID": 1, "itemKey": "ABCD1234", "title": "…", "page": "42" },
    "createdAt": "…", "updatedAt": "…",
    "anki": null }
]}
```

`key` is the normalised text (lower case, collapsed whitespace, no punctuation at the edges). It is the only identity key: it is also the first field of the Anki note.

## Key flows

**Adding a word.** Selection → `renderTextSelectionPopup` → the context sentence from the page characters → offline translation and expression lookup (instant, shown immediately) → if an API key is set, a request to the model with the sentence; the answer replaces the translation and adds an explanation → click «＋ В словарь» → `Store.add()` → `words-changed` → `Highlighter.refreshAll()`. If there is no network or the service returned an error, the offline result stays, with a note.

**Highlighting and translation on hover.** `renderToolbar` reports that a PDF reader is open → `Reader` attaches `Highlighter.attach(view)` → for each rendered page, text is built from Zotero's characters, a regex looks for dictionary words in it, rectangles are computed per line for the matches and drawn as a layer on top of the page (refreshed on the pdf.js `pagerendered` events and by a check every 0.5 s) → `mousemove` over a match → after `hoverDelay` ms the tooltip appears. If a different form of a saved word is found («quivered» for «quivering»), the tooltip shows the saved word and its translation («quivering — дрожащий») with a note that the text has a different form; the translation of the form is not requested. Clicking a highlighted word pins the tooltip and shows the «Удалить из словаря» (delete from dictionary) button. Word forms (carry → carried/carries, «appear to» → «appeared to») are matched both in highlighting and in `Store.lookup()` (by word stems, `Morph`).

**Anki export without duplicates.** `Store.pendingAnki()` (not yet exported) → `ensureSetup()` (the deck and note type, if missing) → `addNotes` with `allowDuplicate:false` → for notes Anki rejects, we look up the existing note and mark `anki.duplicate = true`. This way a word is never duplicated, neither on a repeated export nor if it is already in Anki.

**Anki note fields:** Word, Translation, Context, Audio, Source. The Audio field is always left empty — fill it in manually or with another add-on. If Anki already has a note type from an older version (with a Definition field), on the first export the plugin adds the Audio field, removes {{Definition}} from the template and deletes the Definition field (its data in Anki is lost; the definition stays in the Zotero dictionary). Anki may then ask for a full sync.

**The Context field in Anki.** On export (nothing changes in the Zotero dictionary), the sentence where the word was first added is taken; the word itself and its forms are replaced with "_" by letter count («The new study ________ __ be strange»), and below it, in italics, a Russian translation of the sentence (online; without internet only the English sentence remains). If the word could not be found in the sentence, the field stays empty so as not to give away the answer. Words exported to Anki by earlier versions get their context on the next export via `updateNoteFields` (only notes created by the plugin).

**Where the settings are.** Tools → «Wordbook: настройки…» (settings), or Edit → Settings (Zotero) → the «Wordbook» section in the left-hand list. There are no plugin settings in the plugin manager — that is how Zotero works.

## Languages

English and Russian are supported in both directions (EN→RU and RU→EN). The book language and the translation language are chosen in the Wordbook settings and with the two «EN → RU» drop-downs in the reader's top bar; usually one book is open while reading, so the book language is chosen manually and limits highlighting and lookup to words of that language.

- A dictionary entry stores the language (`lang`) and the translation language (`dst`); old entries are treated as English with translation into Russian. The entry key for English is the word itself, for Russian it is `ru:word`. A tag like `lang-en-ru` is added to the Anki note.
- English words are reduced to a stem by inflection only (-s, -ed, -ing): Snowball's derivational suffixes are not stripped, so «depart» and «department» are different words. Word forms are matched by Snowball stems (English and Russian; `content/lib/snowball.js`, ISC). The stem can be inaccurate (irregular verbs, fleeting vowels: «подарок» ≠ «подарки»); for short words (up to 4 letters) the stem is not applied.
- The offline dictionary, the idiom database and the "base form" feature work only for EN→RU. For RU→EN, translation is online only (Google Translate by default; Gemini/DeepSeek translate in context and explain idioms). Without internet there is no translation in this direction.

## Translation: online and offline

**Offline (works right after installation, nothing to download)**
- An EN→RU dictionary (~44k words and phrases) built from OpenRussian data. Words and their forms («carried», «went», «children») are reduced to the base form.
- A database of ~39k expressions: WordNet (phrasal verbs, idioms, compound nouns) plus the author's list of ~580 common idioms, phrasal verbs and fixed expressions (including ones from academic texts) with Russian equivalents.
- This is a basic dictionary: translations are chosen by frequency, without regard to context, and polysemous words may be inaccurate.

**Online (by default free and keyless)**
- By default "Google Translate" is used via the open web address `translate.googleapis.com` (no key and no payment). It translates the selected fragment **without the sentence** and does not explain idioms; alternatives come from the dictionary part of the response. If the offline lookup finds the author's translation of an idiom, it stays the primary one and the machine translation goes to the alternatives.
- Optional: Google Gemini (a key from Google AI Studio, with a free tier) or DeepSeek / any OpenAI-compatible service (paid). They translate in context and explain idioms in Russian (JSON response: translation, alternatives, expression type, explanation).
- In the Wordbook settings the service is chosen from a list; there is an option «Выключено (только офлайн)» (off, offline only) and a «Проверить подключение» (test connection) button.
- The selected text (and, for Gemini/DeepSeek, the sentence) is sent to the chosen service.

**Base form.** If a word form is selected («went», «traces», «children», «stopped»), the popup shows a block «Начальная форма: go — идти» (base form: go — to go) with a «＋ В словарь: «go»» (add to dictionary: "go") button. The translation is taken offline and refined online (if enabled). For words that only look like forms («news», «number», «early») the block is not shown.

**Translating sentences and paragraphs.** A selection longer than a word or short phrase (more than 8 words or 80 characters) is translated whole, up to 8000 characters. The text is cleaned of hyphenation and line breaks. Gemini / DeepSeek get a dedicated translator prompt (exact meaning without omissions, natural style, idioms by meaning, preserving tone and terms) and the surrounding page text (up to 600 characters before the selection and 300 after) — only for understanding the context; it is not translated. Google Translate (free mode) translates in chunks by paragraph/sentence without context. Without internet, fragments are not translated. The same mechanism translates the context sentence for Anki cards.

**Which service to choose.** "Google Translate" works immediately, without a key, but without context. For translation in context: Gemini (a key from Google AI Studio; the Gemini API is **not available from Russia without a VPN** — the service answers "User location is not supported"), OpenRouter (a key from openrouter.ai/keys; the default model is the free `meta-llama/llama-3.3-70b-instruct:free`, and the free tier is limited to about 50 requests per day; the model name can be changed in the settings) or DeepSeek (paid). If a Gemini key is entered but no service is selected, Gemini is used. By default the alias `gemini-flash-latest` (the current Flash model) is used, and the minimum "thinking" level is requested (`thinkingLevel: low`, on refusal `thinkingBudget: 0`, then no parameter): Gemini 3 models default to a high level, and a simple translation took tens of seconds. If the selected service does not respond (no network, region, limit, wrong key), a fallback Google Translate result is shown with a note of the reason; the «Проверить подключение» (test connection) button shows the real error.

**Idiom labels.** Offline: the whole selection is an expression; the selection contains an expression; the selected word is part of an expression in the sentence («Возможно, часть выражения…», "possibly part of the expression…"). Online, the model's judgement is added to this.

**Optional:** load your own StarDict dictionary (for example, Mueller's): Tools → «Wordbook: загрузить словарь» (load dictionary). It takes priority over the `en-ru` pack.

**Data licenses.** The packs derived from OpenRussian and CC-CEDICT are CC BY-SA 4.0, FreeDict ones GPL, WordNet is under the Princeton University license; the texts are in `licenses/` and the license of each pack is in the pack and in the catalog. Rebuilding the en-ru source: `python3 tools/build_data.py <csv_openrussian> <wordnet_dict>`; all packs: `python3 tools/build_packs.py`.

## Development

1. Create a separate Zotero profile for development (`zotero -p`) and a separate data directory.
2. Build: `./build.sh` → `dist/zotero-wordbook-<version>.xpi` (the manifest files are at the root of the archive).
3. Zotero → Tools → Plugins → ⚙ → Install Plugin From File.
4. Log: Help → Debug Output Logging → View Output, filter `[Wordbook]`.
5. Anki: the running application plus the AnkiConnect add-on.
6. Release: bump `version` in `manifest.json`, run `./build.sh` (it also updates `update.json`), create a `vX.Y.Z` tag — GitHub Actions builds the `.xpi` and attaches it to the release. The plugin ID `zotero-wordbook@vezzes.github.io` must not be changed: Zotero would treat it as a different plugin.

## Risks

1. **Internal reader APIs.** `reader._internalReader._primaryView`, `view._iframeWindow`, `view._pdfPages[i].chars`, `PDFViewerApplication.pdfViewer.getPageView()`, `Zotero.Reader._readers` are undocumented (they exist in the Zotero sources but may change). Everything is collected in `reader.js` and `highlighter.js`.
2. **PDF highlighting** is drawn as a `.wbOverlay` layer inside `div.page`: check page rotation, two-page mode and the dark theme.
3. **Free Google Translate is an unofficial endpoint**: it may change, limit frequent requests (429) or be unavailable in some regions; then the offline translation remains, with a note. **Online translation has not been tested against real servers**: the requests were checked against the Gemini and DeepSeek documentation and tested on a mock server (key errors, model 404, no JSON mode, no network). Model names change; if the default model becomes obsolete, the plugin picks the current Flash model of Gemini; for DeepSeek the name can be set in the settings.
4. **Dictionary packs** are read and written with `IOUtils` and downloaded with `Zotero.HTTP.request(..., {responseType: "arraybuffer"})`; the SHA-256 check uses `crypto.subtle` (or XPCOM `nsICryptoHash`). Not verified in real Zotero yet. Opening the settings uses `Zotero.Utilities.Internal.openPreferences("wordbook-prefpane")`. Both calls should be checked on 10.0.6.
5. **Quality of the basic dictionary** is limited by its source: it is a "Russian to English" dictionary turned around. For stronger translations there is the online mode and (optionally) loading Mueller.
6. **Offline idioms**: WordNet covers idioms incompletely, so the author's list was added; rare expressions are not recognised offline. "Weak" compound nouns (for example, «ice cream») are shown only when selected whole.
7. **The API key** is stored in Zotero's preferences in plain text (like other settings).
8. **Sync between devices** is not implemented.

**Free Google Translate with context.** For a word with a known sentence, the word is put in square brackets, the whole sentence is translated, and whatever ended up in the brackets is extracted from the translation (`Translator._googleInContext`). If that fails, the plain word translation is used.

**Base form for Russian.** `Lemma.ruBase()` picks the base form from the headwords of the downloaded `ru-*` pack (a shared Snowball stem + the longest common prefix); the `ru-*` packs also contain inflected forms as `→headword` redirects, which are tried first; the translation is online. If the online model returned a `lemma`, it is offered too (for any language). The selection is heuristic and sometimes wrong («людям» → «люд»).
**Google Translate:** both requests (the word and the sentence with brackets) run in parallel; on a network failure or a 5xx response, one retry.

**Dictionary form of the translation.** The translation of a word in context arrives in the form used in the sentence («subpar tools» → «некачественные»). The dictionary needs the base form: Gemini/OpenRouter/DeepSeek are asked to give the translation of the single word in dictionary form (context only affects the choice of meaning); for Google the form is derived by rules (`Lemma.ruDictForm`: adjective endings, then the dictionary word list).

**Fallback free service.** If Google Translate is unavailable (request limit, 5xx error, no connection), words and fragments are translated by Microsoft Translator through the same public access the Edge browser uses (`Translator._edgeRaw`: token from `edge.microsoft.com/translate/auth`, translation from `api-edge.cognitive.microsofttranslator.com`). No key is needed; the caption says «Microsoft Translator (запасной вариант)» (fallback). It also works as a fallback for Gemini/OpenRouter/DeepSeek. The address is unofficial and may change.

## Languages and offline packs (1.1.0)

- **Languages**: `Wordbook.LANGS` (en, zh, de, fr, es, pt, ru) holds the interface name, the name for translation prompts and the language codes of Google (`google`) and Microsoft (`ms`) for each language. Any two different languages can be paired.
- **Matching**: Snowball stemmers for en, ru, de, fr, es, pt (`content/lib/snowball.js`); Chinese is matched as a plain substring, the longest saved word first (`Morph._findAllSubstring`). A language without a stemmer would be compared as written.
- **Packs**: a pack is `{format, id, src, dst, version, name, license, source, entries, [idioms], [note]}`, `entries` maps a lowercase key to `"t1|t2|…"`, `"→headword"` (an inflected form) or a value starting with an item `"~reading"` (pinyin). The pack of the current pair is loaded by `Packs.prepare()` (also when the language preferences change). en→ru keeps the richer logic (`Dict`, `Idioms`, English word-form rules); the other pairs use `PackDict.lookup` (exact key, then stem index of the headwords).
- **Catalog and hosting**: `catalog.json` and the packs are release assets under the tag `dictionaries` of the repository (`Packs.DEFAULT_URL`; the `packsUrl` preference overrides it). `tools/build_packs.py` builds them; the `Build dictionaries` workflow publishes them.
- **No pivot through English**: offline translation for a pair needs a dictionary for exactly that pair; otherwise only online translation works.
