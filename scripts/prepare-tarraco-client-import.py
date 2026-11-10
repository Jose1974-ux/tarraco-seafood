"""Stream an idempotent import to a private database connection, with rollback by default."""

import argparse
import base64
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("extraction", type=Path)
    parser.add_argument("--apply", action="store_true", help="Confirm the transaction")
    args = parser.parse_args()
    data = json.loads(args.extraction.read_text(encoding="utf-8"))
    if data["review"]["duplicate_codes"]:
        parser.error("La extracción contiene códigos repetidos.")
    review_codes = {code for group in data["review"]["possible_duplicate_groups"] for code in group}
    rows = [dict(row, review=row["customer_code"] in review_codes) for row in data["clients"]]
    encoded = base64.b64encode(json.dumps(rows, ensure_ascii=False).encode()).decode()
    print("begin;")
    print("set local lock_timeout = '10s';")
    print("do $payload$ begin")
    print(f"  perform set_config('tarraco.client_import', convert_from(decode('{encoded}', 'base64'), 'UTF8'), true);")
    print("end $payload$;")
    print(Path(__file__).with_name("import-tarraco-clients.sql").read_text(encoding="utf-8"))
    print("commit;" if args.apply else "rollback;")


if __name__ == "__main__":
    main()
