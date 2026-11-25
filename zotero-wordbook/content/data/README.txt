Zotero Wordbook built-in data

dict-basic.json  — EN→RU dictionary. Built by "inverting" the OpenRussian data
                   (https://en.openrussian.org, https://github.com/Badestrand/russian-dictionary),
                   licence CC BY-SA 4.0 (text: OPENRUSSIAN-LICENSE.txt).
                   This file is a derivative work and is distributed under the same terms (CC BY-SA 4.0).
idioms.json      — multi-word expressions. Based on WordNet 3.1 (Princeton University,
                   licence: WORDNET-LICENSE.txt) + the hand-curated list tools/idioms-curated.tsv
                   with Russian equivalents.

Rebuild: python3 tools/build_data.py <openrussian_csv_dir> <wordnet_dict_dir>
