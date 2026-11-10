"""Recompose the five horizontal page groups in the TARRACO client PDF."""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import unicodedata
import xml.etree.ElementTree as ET


COLUMNS = (
    (("customer_code", 0), ("name", 129)),
    (("trade_name", 0), ("accounting_code", 468)),
    (("tax_id", 0), ("address", 170)),
    (("phone", 0), ("town", 162), ("postal_code", 409)),
    (("province", 0),),
)
HEADERS = [
    ["Código", "Nombre"],
    ["Alias", "Cod. Contable"],
    ["NIF", "Dirección"],
    ["Teléfono", "Población", "Código Postal"],
    ["Provincia"],
]


def key(value):
    value = unicodedata.normalize("NFKD", value.casefold())
    return "".join(ch for ch in value if ch.isascii() and ch.isalnum())


def extract(pdf):
    xml = subprocess.check_output(["pdftotext", "-bbox-layout", str(pdf), "-"])
    pages = ET.fromstring(xml).findall(".//{*}page")
    if len(pages) != 90:
        raise ValueError("Se esperaba el listado original de 90 páginas.")
    records = {}
    for block, columns in enumerate(COLUMNS):
        for page_index in range(18):
            cells = defaultdict(list)
            for word in pages[block * 18 + page_index].findall(".//{*}word"):
                x = float(word.get("xMin"))
                y = (float(word.get("yMin")) - 55.078) / 14.522
                row = round(y)
                if abs(y - row) > .02 or not 0 <= row < (47 if page_index < 17 else 10):
                    raise ValueError(f"Fila fuera de la cuadrícula en página {block * 18 + page_index + 1}.")
                field = next(name for name, left in reversed(columns) if x >= left - .2)
                cells[row, field].append((x, word.text))
            for row in range(47 if page_index < 17 else 10):
                values = {
                    name: " ".join(word for _, word in sorted(cells[row, name]))
                    for name, _ in columns
                }
                if page_index == row == 0:
                    if list(values.values()) != HEADERS[block]:
                        raise ValueError(f"Cabecera inesperada en el bloque {block + 1}.")
                    continue
                records.setdefault((page_index, row), {}).update(values)
    for (page, row), record in records.items():
        code = record["customer_code"]
        if not re.fullmatch(r"\d+(?:\.\d{3})*", code) or not record["name"]:
            raise ValueError(f"Falta el código o el nombre en la página {page + 1}, fila {row + 1}.")
        record["customer_code"] = code.replace(".", "")
    return list(records.values())


def review(records):
    codes = Counter(r["customer_code"] for r in records)
    groups = defaultdict(list)
    for row in records:
        name, tax_id, address, town = (key(row[k]) for k in ("name", "tax_id", "address", "town"))
        if name and address and town:
            groups[name, address, town].append(row["customer_code"])
        elif name and tax_id:
            groups[name, tax_id].append(row["customer_code"])
    possible_duplicates = [group for group in groups.values() if len(set(group)) > 1]
    repeated_codes = [code for code, count in codes.items() if count > 1]
    shared_tax = Counter(key(r["tax_id"]) for r in records if key(r["tax_id"]))
    return {
        "records": len(records),
        "unique_codes": len(codes),
        "duplicate_codes": repeated_codes,
        "possible_duplicate_groups": possible_duplicates,
        "shared_tax_id_groups": sum(count > 1 for count in shared_tax.values()),
        "with_phone": sum(bool(r["phone"]) for r in records),
        "with_tax_id": sum(bool(r["tax_id"]) for r in records),
        "without_phone_or_tax_id": sum(not r["phone"] or not r["tax_id"] for r in records),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("output", type=Path, help="JSON privado nuevo fuera del repositorio")
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[1]
    if args.output.resolve().is_relative_to(repository):
        parser.error("Guarda los datos fuera del repositorio.")
    records = extract(args.pdf)
    report = review(records)
    with args.pdf.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600),
                   "w", encoding="utf-8") as output:
        json.dump({"sha256": digest,
                   "review": report, "clients": records}, output, ensure_ascii=False, indent=2)
    print(json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in report.items()}))


if __name__ == "__main__":
    main()
