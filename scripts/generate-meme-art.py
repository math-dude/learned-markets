"""Write the demo meme coin art to apps/web/public/memes and its catalogue to memes.json.

Every image is self-made: a gradient, one emoji or simple shape and a short badge.
Run with `python3 scripts/generate-meme-art.py`.
"""

import json
from html import escape
from pathlib import Path

# name, ticker, emoji, gradient start, gradient end, badge
MEMES = [
    ("Vice City Sunset", "VICE", "🌴", "#ff3cac", "#784ba0", "VICE CITY"),
    ("Leonida Nights", "LEON", "🌇", "#f7971e", "#ff006e", "LEONIDA"),
    ("Lucia Run", "LUCIA", "🏎️", "#ff5f6d", "#ffc371", "LUCIA"),
    ("Six Delay Wait", "GTA6", "⏳", "#00c6ff", "#7a00ff", "2026 LOL"),
    ("Flamingo Drift", "FLAMO", "🦩", "#ff9a9e", "#a18cd1", "DRIFT"),
    ("Neon Swamp Gator", "GATOR", "🐊", "#11998e", "#38ef7d", "FLORIDA"),
    ("Skibidi Toilet", "SKBDI", "🚽", "#4facfe", "#00f2fe", "SKIBIDI"),
    ("Rizz Lord", "RIZZ", "😏", "#f953c6", "#b91d73", "W RIZZ"),
    ("Sigma Grindset", "SIGMA", "🗿", "#232526", "#6b7a8f", "SIGMA"),
    ("Very Demure", "DEMURE", "💅", "#fbc2eb", "#a6c1ee", "MINDFUL"),
    ("Brain Rot", "ROT", "🧠", "#a8e063", "#56ab2f", "BRAIN ROT"),
    ("Moo Deng", "MOODNG", "🦛", "#ff758c", "#ff7eb3", "BOUNCY"),
    ("Chill Guy", "CHILL", "🐶", "#43cea2", "#185a9d", "CHILL"),
    ("Hawk Tuah", "HAWK", "🦅", "#c79081", "#dfa579", "SPIT ON"),
    ("Tralalero Tralala", "TRALA", "🦈", "#00b4db", "#0083b0", "TRALALA"),
    ("Bombardiro Croc", "BOMBO", "🐊", "#606c88", "#3f4c6b", "BRAINROT"),
    ("Labubu", "LABUBU", "🐰", "#ffafbd", "#ffc3a0", "BLIND BOX"),
    ("Six Seven", "SIX7", "🤷", "#f12711", "#f5af19", "6 7"),
    ("Aura Farming", "AURA", "✨", "#8e2de2", "#4a00e0", "+1000 AURA"),
    ("Dubai Chocolate", "DUBAI", "🍫", "#603813", "#b29f94", "PISTACHIO"),
    ("Mewing Streak", "MEW", "🤫", "#2b5876", "#4e4376", "MEWING"),
    ("Looksmaxxing", "LMAXX", "🪞", "#e0eafc", "#90a4c8", "MAXXING"),
    ("Gyatt Moment", "GYATT", "😳", "#ff512f", "#dd2476", "GYATT"),
    ("Fanum Tax", "FANUM", "🍟", "#f09819", "#edde5d", "TAXED"),
    ("Ohio Final Boss", "OHIO", "🌽", "#56ccf2", "#2f80ed", "ONLY IN"),
    ("Delulu Era", "DELULU", "🦄", "#f8b500", "#fceabb", "DELULU"),
    ("Mog Cat", "MOG", "😼", "#1d2b64", "#f8cdda", "MOGGED"),
    ("Grimace Shake", "GRIMC", "🥤", "#7f00ff", "#e100ff", "SHAKE"),
    ("Roman Empire", "ROMAN", "🏛️", "#c9d6ff", "#e2e2e2", "DAILY"),
    ("Girl Dinner", "DINNER", "🧀", "#ffecd2", "#fcb69f", "DINNER"),
    ("Pedro Racoon", "PEDRO", "🦝", "#4b6cb7", "#182848", "PEDRO"),
    ("Capybara Okay", "CAPY", "🦫", "#d1913c", "#ffd194", "OK I PULL UP"),
    ("NPC Stream", "NPC", "🤖", "#3a7bd5", "#00d2ff", "ICE CREAM"),
    ("Hit The Griddy", "GRIDDY", "🕺", "#ee0979", "#ff6a00", "GRIDDY"),
    ("Main Character", "MAINC", "🎬", "#614385", "#516395", "MAIN CHAR"),
    ("Touch Grass", "GRASS", "🌱", "#0ba360", "#3cba92", "TOUCH IT"),
    ("Ick Factor", "ICK", "🤢", "#76b852", "#8dc26f", "THE ICK"),
    ("Slay Queen", "SLAY", "👑", "#ff0084", "#33001b", "SLAY"),
    ("Bussin Bowl", "BUSSIN", "🍜", "#ff9966", "#ff5e62", "NO CAP"),
    ("Stanley Cup", "STNLY", "🥤", "#89f7fe", "#66a6ff", "40 OZ"),
    ("Sahur Drum", "SAHUR", "🥁", "#834d9b", "#d04ed6", "TUNG TUNG"),
    ("Big Back Snack", "BIGBK", "🍔", "#f2994a", "#f2c94c", "BIG BACK"),
]


def svg(ticker, emoji, a, b, badge):
    t, e, g = escape(ticker), escape(emoji), escape(badge)
    width = max(72, 15 * len(badge) + 28)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>
<radialGradient id="s" cx="0.5" cy="0.42" r="0.5"><stop offset="0" stop-color="#fff" stop-opacity="0.45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
<rect width="256" height="256" rx="40" fill="url(#g)"/>
<circle cx="128" cy="108" r="92" fill="url(#s)"/>
<text x="128" y="138" font-size="104" text-anchor="middle" font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif">{e}</text>
<rect x="{128 - width / 2:.0f}" y="178" width="{width}" height="40" rx="20" fill="#000" fill-opacity="0.55"/>
<text x="128" y="205" font-size="22" font-weight="800" text-anchor="middle" fill="#fff" font-family="Inter,Helvetica,Arial,sans-serif" letter-spacing="1">{g}</text>
<text x="20" y="38" font-size="18" font-weight="800" fill="#fff" fill-opacity="0.9" font-family="Inter,Helvetica,Arial,sans-serif">${t}</text>
</svg>
"""


def main():
    out = Path(__file__).resolve().parent.parent / "apps/web/public/memes"
    out.mkdir(parents=True, exist_ok=True)
    catalogue = []
    for name, ticker, emoji, a, b, badge in MEMES:
        assert 2 <= len(name) <= 32 and 2 <= len(ticker) <= 6 and ticker.isalnum() and ticker.isupper(), ticker
        path = f"{ticker.lower()}.svg"
        (out / path).write_text(svg(ticker, emoji, a, b, badge), encoding="utf-8")
        catalogue.append({"name": name, "ticker": ticker, "image": f"/memes/{path}"})
    assert len({m["ticker"] for m in catalogue}) == len(catalogue)
    (out / "memes.json").write_text(json.dumps(catalogue, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(catalogue)} memes to {out}")


if __name__ == "__main__":
    main()
