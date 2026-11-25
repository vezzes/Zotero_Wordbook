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
- **Book language and translation language** are chosen in the reader toolbar (English ↔ Russian).

## Translation: what is used

| Mode | What you need | Notes |
|---|---|---|
| **Free** (default) | nothing | Google Translate; if it fails, Microsoft Translator. The endpoints are unofficial and may limit frequent requests or change. Takes the sentence around the word into account. |
| **Gemini** | a key from [Google AI Studio](https://aistudio.google.com/api-keys) | Best at using context and explaining idioms. |
| **OpenRouter** | an OpenRouter key | Free models are available (limits are set by the service). |
| **DeepSeek / OpenAI-compatible** | an API key and URL | Any compatible service. |
| **Offline** | nothing | The built-in EN→RU dictionary (about 44,000 words and expressions) and the idiom database work without internet. There is no offline translation for RU→EN. |

The API key is stored in Zotero's preferences in plain text. The selected text and the surrounding sentence are sent to the online service you choose.

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
- There is no dictionary sync between devices. The data lives in the Zotero data folder, in the `wordbook/` subfolder.

## Development

```
./build.sh          # builds dist/zotero-wordbook-<version>.xpi and updates update.json
```

Architecture, data model and risk notes are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). To release: bump `version` in `manifest.json`, commit, and create a `vX.Y.Z` tag — GitHub Actions builds the `.xpi` and attaches it to the release.

The plugin was built with the help of the AI assistant Claude (Anthropic). It was tested manually on Zotero 10.0.8 and with scripts against a mock environment; bug reports are welcome in [Issues](https://github.com/vezzes/Zotero_Wordbook/issues).

## Licenses

Code: MIT (`LICENSE`). The built-in EN→RU dictionary is a derivative work of OpenRussian (CC BY-SA 4.0), the expression database is WordNet, the stemmers are Snowball (ISC/BSD). Details are in [`THIRD_PARTY.md`](THIRD_PARTY.md).
