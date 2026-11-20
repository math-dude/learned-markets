#!/usr/bin/env bash
# Copies the pump-events plugin into a jetstreamer (vaultic-win fork) checkout and registers it
# as a built-in plugin (`--with-plugin pump-events`). Safe to run more than once.
#
# Usage: ./install.sh /path/to/jetstreamer
set -euo pipefail

JS="${1:?usage: install.sh /path/to/jetstreamer}"
HERE="$(cd "$(dirname "$0")" && pwd)"

cp "$HERE/pump_events.rs" "$JS/jetstreamer-plugin/src/plugins/pump_events.rs"

python3 - "$JS" <<'PY'
import sys, pathlib
js = pathlib.Path(sys.argv[1])

def patch(path, old, new, marker):
    p = js / path
    s = p.read_text()
    if marker in s:
        return
    if old not in s:
        sys.exit(f"install.sh: anchor not found in {path}: {old!r}")
    p.write_text(s.replace(old, new, 1))

plugins = js / "jetstreamer-plugin/src/plugins.rs"
s = plugins.read_text()
if "pub mod pump_events;" not in s:
    plugins.write_text(s.rstrip() + "\n/// pump.fun and PumpSwap events plus pump-token transfers.\npub mod pump_events;\n")

lib = "src/lib.rs"
patch(lib, "pubkey_stats::PubkeyStatsPlugin,",
      "pubkey_stats::PubkeyStatsPlugin, pump_events::PumpEventsPlugin,",
      "pump_events::PumpEventsPlugin")
patch(lib, "    /// Pubkey Stats.\n    PubkeyStats,\n}",
      "    /// Pubkey Stats.\n    PubkeyStats,\n    /// Pump Events.\n    PumpEvents,\n}",
      "    PumpEvents,\n}")
patch(lib, "        Self::PubkeyStats,\n    ];",
      "        Self::PubkeyStats,\n        Self::PumpEvents,\n    ];",
      "        Self::PumpEvents,\n    ];")
patch(lib, 'Self::PubkeyStats => "pubkey-stats",',
      'Self::PubkeyStats => "pubkey-stats",\n            Self::PumpEvents => "pump-events",',
      'Self::PumpEvents => "pump-events"')
patch(lib, "Self::PubkeyStats => Box::new(PubkeyStatsPlugin::new()),",
      "Self::PubkeyStats => Box::new(PubkeyStatsPlugin::new()),\n            Self::PumpEvents => Box::new(PumpEventsPlugin::new()),",
      "Box::new(PumpEventsPlugin::new())")
print("pump-events plugin installed into", js)
PY
