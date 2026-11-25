# Third-party components

The plugin's own code is MIT-licensed (see `LICENSE`). The bundled data and libraries below keep their own licenses.

| Component | Files | License |
|---|---|---|
| **OpenRussian** data (https://en.openrussian.org, https://github.com/Badestrand/russian-dictionary) — the built-in EN→RU dictionary is a derivative work (the data inverted) | `content/data/dict-basic.json` | CC BY-SA 4.0 — `content/data/OPENRUSSIAN-LICENSE.txt`. The derivative file is distributed under the same license. |
| **WordNet 3.1** (Princeton University) — multi-word expressions | `content/data/idioms.json` | WordNet License — `content/data/WORDNET-LICENSE.txt` |
| **Snowball stemmers** (Martin Porter, Richard Boulton), JavaScript build `snowball-stemmers` 0.6.0 by Oleg Mazko — English and Russian only | `content/lib/snowball.js` | ISC / BSD-3-Clause — `content/lib/SNOWBALL-LICENSE.txt` |
| Author's list of idioms with Russian equivalents | `tools/idioms-curated.tsv` (merged into `idioms.json`) | MIT |

Online translation services (Google Translate, Microsoft Translator, Gemini, OpenRouter, DeepSeek / OpenAI-compatible APIs) are not bundled: the plugin only calls them over the network when the user enables them; their terms of use apply. The free Google and Microsoft endpoints are unofficial and may change or stop working.
