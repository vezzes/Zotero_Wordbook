# Changelog

## 1.1.1
- Anki export: words that already exist in Anki are now replaced automatically (translation, context, source are refreshed; the Audio field is kept). A single duplicate no longer blocks the export.

## 1.1.0
- Seven languages in both directions: English, Chinese, German, French, Spanish, Portuguese, Russian.
- Inflected-form matching for German, French, Spanish and Portuguese (Snowball); Chinese words matched as written.
- Offline dictionaries are no longer bundled: they are downloaded on demand in Settings → Wordbook → «Офлайн-словари» (including English → Russian with the idiom database). The plugin file is much smaller.
- Dictionaries for Russian → English/German, German → Russian, Chinese ↔ English (with pinyin), English ↔ French/Portuguese, Spanish → English, German ↔ Portuguese.
- Sentence detection for Chinese punctuation.

## 1.0.0
- First public release (the earlier 0.x numbers were development builds).
- Everything listed below, plus the plugin ID moved to `zotero-wordbook@vezzes.github.io`.

## 0.5.7
- Fallback free translator: Microsoft Translator (Edge) is used when Google Translate refuses or is unreachable.

## 0.5.6
- Word translations are saved in dictionary form (e.g. «некачественный», not «некачественные»).

## 0.5.5
- Russian base-form suggestion; parallel Google requests with one retry.

## 0.5.4
- Free Google translation takes the sentence into account.

## 0.5.3
- «depart» and «department» are no longer treated as the same word (English matching follows inflection only).

## 0.5.2
- Another form of a saved word shows the saved word and its translation.

## 0.5.0
- Click a highlighted word to delete it from the dictionary.

## 0.4.x
- Translation of whole sentences and paragraphs; Gemini / OpenRouter / DeepSeek; settings pane; popup layout fixes.

## 0.3 – 0.4
- English ↔ Russian in both directions; Anki export with a masked Context field and an empty Audio field.

## 0.1 – 0.2
- First versions: add a selected word, highlight it in all PDFs, translation on hover, Anki export without duplicates.
