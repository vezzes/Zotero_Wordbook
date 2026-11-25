#!/usr/bin/env python3
"""Writes update.json using the version from manifest.json (the link points to the release file on GitHub)."""
import json, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
m = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
z = m["applications"]["zotero"]
v = m["version"]
repo = m["homepage_url"].rstrip("/")
update = {
    "addons": {
        z["id"]: {
            "updates": [
                {
                    "version": v,
                    "update_link": f"{repo}/releases/download/v{v}/zotero-wordbook-{v}.xpi",
                    "applications": {"zotero": {"strict_min_version": z["strict_min_version"]}},
                }
            ]
        }
    }
}
(root / "update.json").write_text(json.dumps(update, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("update.json:", v)
