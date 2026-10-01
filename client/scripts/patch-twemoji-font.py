#!/usr/bin/env python3
"""Builds src/assets/fonts/twemoji-voicaw.woff2 from the twemoji-colr-font package.

The font joins multi-part emoji (a ZWJ sequence like the rainbow flag, U+1F3F3 U+FE0F U+200D
U+1F308) with ligatures that include the U+FE0F variation selector. Chrome and Safari drop
that selector before the font sees the text (the font has no variation-sequence cmap), so
those ligatures never matched and the emoji showed as two (white flag + rainbow). Firefox
was fine. This adds a copy of each such ligature without the FE0Fs, so they match either
way. The font is renamed "Voicaw Twemoji" (it's a modified version; SIL OFL 1.1).

Run from client/ after updating twemoji-colr-font (needs: pip install fonttools brotli):
    python3 scripts/patch-twemoji-font.py
"""
import shutil
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.ttLib.tables import otTables

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = next(p for p in (ROOT / 'node_modules/twemoji-colr-font', ROOT.parent / 'node_modules/twemoji-colr-font') if p.exists())
OUT = ROOT / 'src/assets/fonts/twemoji-voicaw.woff2'
NAME = 'Voicaw Twemoji'

font = TTFont(PACKAGE / 'twemoji.woff2')
vs16 = font.getBestCmap()[0xFE0F]

added = 0
for lookup in font['GSUB'].table.LookupList.Lookup:
    for subtable in lookup.SubTable:
        subtable = getattr(subtable, 'ExtSubTable', subtable)
        if not hasattr(subtable, 'ligatures'):
            continue
        for first, ligatures in subtable.ligatures.items():
            if first == vs16:
                continue
            existing = {tuple(lig.Component) for lig in ligatures}
            extra = []
            for lig in ligatures:
                components = [g for g in lig.Component if g != vs16]
                if not components or len(components) == len(lig.Component) or tuple(components) in existing:
                    continue
                copy = otTables.Ligature()
                copy.LigGlyph = lig.LigGlyph
                copy.Component = components
                copy.CompCount = len(components) + 1
                extra.append(copy)
                existing.add(tuple(components))
            if extra:
                ligatures.extend(extra)
                # The first matching ligature wins: longest first.
                ligatures.sort(key=lambda lig: -len(lig.Component))
                added += len(extra)

name = font['name']
for record in list(name.names):
    if record.nameID in (1, 4, 16):
        name.setName(NAME, record.nameID, record.platformID, record.platEncID, record.langID)
    elif record.nameID == 6:
        name.setName(NAME.replace(' ', ''), 6, record.platformID, record.platEncID, record.langID)
name.setName('Twemoji Mozilla (twemoji-colr-font), modified for Voicaw: ligatures also match without U+FE0F. '
             'Licensed under the SIL Open Font License, Version 1.1.', 13, 3, 1, 0x409)
name.setName('https://openfontlicense.org', 14, 3, 1, 0x409)

font.flavor = 'woff2'
OUT.parent.mkdir(parents=True, exist_ok=True)
font.save(OUT)
shutil.copy(PACKAGE / 'LICENSE', OUT.with_suffix('.LICENSE.txt'))
print(f'{OUT.relative_to(ROOT)}: added {added} ligatures without FE0F')
