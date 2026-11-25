# Third-party components

The plugin's own code is MIT-licensed (see `LICENSE`). The bundled library and the dictionaries built from the data below keep their own licenses. The dictionaries are **not** part of the plugin file: they are built from open sources, published as assets of the project's `dictionaries` release and downloaded by the user on request.

| Component | Files | License |
|---|---|---|
| **OpenRussian** data (https://en.openrussian.org, https://github.com/Badestrand/russian-dictionary) — the packs ru→en, ru→de, en→ru, de→ru are derivative works | `packs-src/en-ru/dict-basic.json`, packs `ru-en`, `ru-de`, `en-ru`, `de-ru` | CC BY-SA 4.0 — `licenses/OPENRUSSIAN-LICENSE.txt`. The derivative packs are distributed under the same license. |
| **WordNet 3.1** (Princeton University) — multi-word expressions | `packs-src/en-ru/idioms.json` (inside the `en-ru` pack) | WordNet License — `licenses/WORDNET-LICENSE.txt` |
| **CC-CEDICT** (https://cc-cedict.org), taken from the npm package `cc-cedict` — Chinese dictionary with pinyin | packs `zh-en`, `en-zh` | CC BY-SA 4.0 |
| **FreeDict** dictionaries (https://freedict.org, https://github.com/freedict/fd-dictionaries) | packs between English, French, Spanish, Portuguese, German | GNU GPL v2 or later (the exact license of each dictionary is shown in the settings and stored in the pack) |
| **Snowball stemmers** (Martin Porter, Richard Boulton), JavaScript build `snowball-stemmers` 0.6.0 by Oleg Mazko — English, Russian, German, French, Spanish and Portuguese are kept | `content/lib/snowball.js` | ISC / BSD-3-Clause — `content/lib/SNOWBALL-LICENSE.txt` |
| Author's list of idioms with Russian equivalents | `tools/idioms-curated.tsv` (merged into the idiom database of the `en-ru` pack) | MIT |

Online translation services (Google Translate, Microsoft Translator, Gemini, OpenRouter, DeepSeek / OpenAI-compatible APIs) are not bundled: the plugin only calls them over the network when the user enables them; their terms of use apply. The free Google and Microsoft endpoints are unofficial and may change or stop working.
