#!/usr/bin/env python3
"""
fetch_option_chain.py

Pulls the Nifty option chain table from Moneycontrol - the same source
your Google Sheet uses via IMPORTHTML - and writes it out as JSON for
the GitHub Pages frontend to consume.

WHY pandas.read_html instead of a hand-rolled parser:
IMPORTHTML(url, "table", index) grabs the Nth <table> on the page.
pandas.read_html(html) does the exact same thing in Python: it returns
a list of DataFrames, one per <table> tag, in document order. So the
TABLE_INDEX below should match the index you're already using in your
IMPORTHTML formula - same source, same mechanism, no need to hand-write
a new markup parser.

>>> FILL THESE IN before running <<<
    MC_URL       - the exact Moneycontrol option chain URL your
                   IMPORTHTML formula points to (include any
                   expiry/index query params it uses)
    TABLE_INDEX  - the same table index your IMPORTHTML formula uses

Everything else (JSON shape, history file, rotation) is ready to run.
"""
import io
import json
import json
import sys
from datetime import datetime, date
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import requests

# ---------------------------------------------------------------------------
# CONFIG - fill in from your existing IMPORTHTML formula
# ---------------------------------------------------------------------------
MC_URL = "https://www.moneycontrol.com/indices/fno/view-option-chain/NIFTY/2026-07-21?"
TABLE_INDEX = 0  # e.g. IMPORTHTML(url, "table", 2) -> index 0 in pandas (0-based)

IST = ZoneInfo("Asia/Kolkata")
REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
HISTORY_DIR = DATA_DIR / "history"

HEADERS = {
    # Moneycontrol serves different/blocked markup to obvious bot user agents
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


def fetch_html(url: str) -> str:
    resp = requests.get(url, headers=HEADERS, timeout=20)
    resp.raise_for_status()
    return resp.text


def extract_table(html: str, table_index: int) -> pd.DataFrame:
    tables = pd.read_html(io.StringIO(html))
    if table_index >= len(tables):
        raise IndexError(
            f"Page only has {len(tables)} <table> tags; "
            f"TABLE_INDEX={table_index} is out of range. "
            f"Open the page's HTML source and recount, same as you did for IMPORTHTML."
        )
    return tables[table_index]


def clean_dataframe(df: pd.DataFrame) -> list[dict]:
    """Drop fully-empty rows/cols, normalise column names, return list of dicts."""
    df = df.dropna(axis=1, how="all").dropna(axis=0, how="all")
    df.columns = [str(c).strip() for c in df.columns]
    # Replace NaN with None so json.dumps emits null, not NaN
    df = df.where(pd.notnull(df), None)
    return df.to_dict(orient="records")


def build_payload(rows: list[dict]) -> dict:
    now_ist = datetime.now(IST)
    return {
        "fetched_at_ist": now_ist.isoformat(),
        "fetched_at_utc": datetime.utcnow().isoformat() + "Z",
        "source": MC_URL,
        "row_count": len(rows),
        "rows": rows,
    }


def write_latest(payload: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "latest.json").write_text(json.dumps(payload, indent=2))


def append_history(payload: dict) -> None:
    """One .jsonl file per IST calendar day - each line is one snapshot.
    This is the 'rolling history' used for replay/trending, and it
    naturally rotates by day so no single file grows unbounded."""
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    today_ist: date = datetime.now(IST).date()
    history_file = HISTORY_DIR / f"{today_ist.isoformat()}.jsonl"
    with history_file.open("a") as f:
        f.write(json.dumps(payload) + "\n")
    update_history_index(today_ist)


def update_history_index(today_ist: date) -> None:
    """Static hosting can't list a directory, so maintain a small manifest
    the frontend can fetch to know which history files exist."""
    index_path = HISTORY_DIR / "index.json"
    existing = set()
    if index_path.exists():
        existing = set(json.loads(index_path.read_text()).get("dates", []))
    existing.add(today_ist.isoformat())
    index_path.write_text(
        json.dumps({"dates": sorted(existing)}, indent=2)
    )


def main() -> int:
    if "PASTE_YOUR" in MC_URL:
        print(
            "MC_URL is still a placeholder - paste your Moneycontrol "
            "option chain URL (and confirm TABLE_INDEX) before running.",
            file=sys.stderr,
        )
        return 1

    html = fetch_html(MC_URL)
    df = extract_table(html, TABLE_INDEX)
    rows = clean_dataframe(df)
    payload = build_payload(rows)

    write_latest(payload)
    append_history(payload)

    print(f"Fetched {len(rows)} rows at {payload['fetched_at_ist']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
