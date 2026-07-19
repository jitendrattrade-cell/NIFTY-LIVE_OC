import requests
import json

BASE_URL = "https://www.nseindia.com"
OPTION_CHAIN_API = "https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=21-Jul-2026"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/option-chain",
    "Connection": "keep-alive"
}

def get_option_chain():
    session = requests.Session()

    # Get cookies
    session.get(BASE_URL, headers=HEADERS, timeout=20)

    # Fetch Option Chain
    response = session.get(
        OPTION_CHAIN_API,
        headers=HEADERS,
        timeout=20
    )

    response.raise_for_status()
    print (response.raise_for_status())
    return response.json()

if __name__ == "__main__":
    data = get_option_chain()
     
    with open("option_chain.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)

    print("Option Chain Saved Successfully")


    records = data["records"]["data"]

    for row in records:
        strike = row["strikePrice"]

        ce = row.get("CE", {})
        pe = row.get("PE", {})

        print(
            strike,
            ce.get("openInterest"),
            ce.get("changeinOpenInterest"),
            ce.get("lastPrice"),
            pe.get("openInterest"),
            pe.get("changeinOpenInterest"),
            pe.get("lastPrice"),
        )
