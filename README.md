# Zotero Wordbook

**A personal vocabulary builder for PDFs in Zotero.** Select a word or phrase in the reader to get its translation and add it to your dictionary. Saved words are highlighted in all your PDFs, and the translation appears when you hover over them. The dictionary exports to Anki without duplicates.

The plugin interface inside Zotero (menus, popups, settings) is currently in Russian; this document quotes the Russian labels exactly, with English glosses in parentheses.

PDF only. Languages: English and Russian, in both directions. Tested on Zotero 10.0.8 (Windows); declared compatibility is Zotero 7–10.

## What it does

- **Selection → translation.** A word, phrase, sentence or paragraph (up to 8000 characters). Words and short phrases get an «＋ В словарь» (add to dictionary) button; longer passages are only translated.
- **Highlighting and translation on hover.** Words from your dictionary are highlighted in all open PDFs, including other forms of the word («appear to» → «appeared to»). Click a highlighted word to get the «Удалить из словаря» (delete from dictionary) button.
- **Base form.** For a selected inflected form, the plugin suggests the base form and its translation; the translation is saved in dictionary form.
- **Idioms and fixed expressions** (English → Russian): the plugin tells you that the selection is an idiom or phrasal verb and shows the Russian equivalent.
- **Anki export** via AnkiConnect, without duplicates. Fields: Word, Translation, Context, Audio, Source. Context holds the sentence where the word first appeared, with the word masked and a Russian translation of the sentence; the Audio field is left empty for you to fill in yourself. If Anki is not running, you can export the dictionary to TSV.
- **Seven languages, both directions:** English, Chinese, German, French, Spanish, Portuguese and Russian. The book language and the translation language are chosen in the reader toolbar. Inflected forms are found for English, German, French, Spanish, Portuguese and Russian; Chinese words are matched as written.
- **Offline dictionaries on demand.** Nothing is bundled: download only the dictionaries you need in Settings → Wordbook → «Офлайн-словари» (offline dictionaries). One dictionary = one direction.

## Translation: what is used

| Mode | What you need | Notes |
|---|---|---|
| **Free** (default) | nothing | Google Translate; if it fails, Microsoft Translator. The endpoints are unofficial and may limit frequent requests or change. Takes the sentence around the word into account. |
| **Gemini** | a key from [Google AI Studio](https://aistudio.google.com/api-keys) | Best at using context and explaining idioms. |
| **OpenRouter** | an OpenRouter key | Free models are available (limits are set by the service). |
| **DeepSeek / OpenAI-compatible** | an API key and URL | Any compatible service. |
| **Offline** | a downloaded dictionary | Works without internet once the dictionary for your language pair is downloaded (see below). English → Russian also includes the idiom database. |

The API key is stored in Zotero's preferences in plain text. The selected text and the surrounding sentence are sent to the online service you choose.

## Offline dictionaries

Settings → Wordbook → **«Офлайн-словари»** lists the available dictionaries with their size, source and license. Press **«Скачать»** (download) next to a pair to install it, **«Удалить»** (delete) to remove it. The pair you currently read is shown first. Dictionaries are stored in the Zotero data folder (`wordbook/packs/`) and work without internet.

| Direction | Source | Size (words) |
|---|---|---|
| Russian → English / German | OpenRussian, with inflected forms | ~225k / ~250k |
| English → Russian (+ idioms) | OpenRussian (inverted), WordNet | ~44k |
| German → Russian | OpenRussian (inverted) | ~69k |
| Chinese → English | CC-CEDICT, with pinyin | ~178k |
| English → Chinese | CC-CEDICT (inverted) | ~89k |
| English ↔ French, English ↔ Portuguese, Spanish → English, German ↔ Portuguese | FreeDict | 4–16k |

Dictionaries are built automatically from open sources (`tools/build_packs.py`); the exact list is in the catalog on the project's release page. The inverted ones are approximate. Pairs without a dictionary work online only.

## Installation

1. Download `zotero-wordbook-<version>.xpi` from the [Releases](https://github.com/vezzes/Zotero_Wordbook/releases) page (right-click it → "Save link as…" if your browser tries to open it).
2. In Zotero: **Tools → Plugins** → gear icon ⚙ → **Install Plugin From File…** → choose the file.
3. Restart Zotero if it asks you to.

Zotero checks for updates by itself, using the address in the plugin manifest.

**Settings:** *Edit → Settings → Wordbook*. There you choose the languages, the translation service and key, the highlight colour and the Anki options. The plugin's menu items are under **Tools**; all start with «Wordbook:» — the dictionary, loading a StarDict dictionary, sending words to Anki, and settings.

## Anki

1. Install the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on in Anki (code `2055492159`) and keep Anki running.
2. **Tools → «Wordbook: отправить новые слова в Anki»** (send new words to Anki). The deck and note type are created automatically; words that were already exported are not added again.

## Limitations

- The plugin relies on undocumented internals of Zotero's PDF reader; after major Zotero updates something may stop working.
- The free Google/Microsoft endpoints are unofficial: expect occasional 429/500 errors, slow responses and changes without notice.
- Word stems are determined by the Snowball algorithm and are sometimes wrong (especially in Russian: «подарок» ≠ «подарки»).
- Finding the Russian base form is heuristic and not always accurate.
- Offline dictionaries differ a lot in size and quality: the small FreeDict ones (4–16k words) cover only common vocabulary. Inverted dictionaries (for example English → Chinese) give approximate variants. Chinese matching has no word segmentation: a saved word is found wherever it occurs as written.
- Online translation is available for every pair; base-form suggestions outside English and Russian come from the offline dictionary or from a model (Gemini, OpenRouter, DeepSeek).
- There is no dictionary sync between devices. The data lives in the Zotero data folder, in the `wordbook/` subfolder.

## Development

```
./build.sh          # builds dist/zotero-wordbook-<version>.xpi and updates update.json
python3 tools/build_packs.py --out dist-packs   # builds the offline dictionaries (needs internet)
```

The dictionaries are published as assets of the release tagged `dictionaries` (the plugin downloads `catalog.json` and the packs from there). Run the **Build dictionaries** workflow (Actions tab → Build dictionaries → Run workflow) to rebuild and publish them.

Architecture, data model and risk notes are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). To release: bump `version` in `manifest.json`, commit, and create a `vX.Y.Z` tag — GitHub Actions builds the `.xpi` and attaches it to the release.

The plugin was built with the help of the AI assistant Claude (Anthropic). It was tested manually on Zotero 10.0.8 and with scripts against a mock environment; bug reports are welcome in [Issues](https://github.com/vezzes/Zotero_Wordbook/issues).

## Licenses

Code: MIT (`LICENSE`). The built-in EN→RU dictionary is a derivative work of OpenRussian (CC BY-SA 4.0), the expression database is WordNet, the stemmers are Snowball (ISC/BSD). Details are in [`THIRD_PARTY.md`](THIRD_PARTY.md).
