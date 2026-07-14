"""Genera el dataset del MVP desde la hoja 'Facturas emitidas 2026'.

No normaliza ni inventa datos de negocio: sólo tipa números y convierte seriales
de fecha de Excel a ISO-8601. Cada registro conserva su fila de origen.
"""

import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path

SOURCE_SHEET = "Facturas emitidas 2026"
NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}


def column_index(reference: str) -> int:
    value = 0
    for character in re.match(r"([A-Z]+)", reference).group(1):
        value = value * 26 + ord(character) - 64
    return value - 1


def text(value):
    if value in (None, ""):
        return None
    if isinstance(value, str) and value.endswith(".0"):
        try:
            return str(int(float(value)))
        except ValueError:
            pass
    return str(value)


def number(value):
    return None if value in (None, "") else float(value)


def excel_date(value):
    if value in (None, ""):
        return None
    return (datetime(1899, 12, 30) + timedelta(days=float(value))).date().isoformat()


def load_workbook(path: Path):
    with zipfile.ZipFile(path) as workbook:
        strings_root = ET.fromstring(workbook.read("xl/sharedStrings.xml"))
        strings = ["".join(item.itertext()) for item in strings_root.findall("m:si", NS)]
        book_root = ET.fromstring(workbook.read("xl/workbook.xml"))
        rels_root = ET.fromstring(workbook.read("xl/_rels/workbook.xml.rels"))
        targets = {item.attrib["Id"]: item.attrib["Target"] for item in rels_root}
        for sheet in book_root.findall("m:sheets/m:sheet", NS):
            if sheet.attrib["name"] != SOURCE_SHEET:
                continue
            relationship = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
            root = ET.fromstring(workbook.read(f"xl/{targets[relationship]}"))
            rows = []
            for row in root.findall("m:sheetData/m:row", NS):
                cells = {}
                for cell in row.findall("m:c", NS):
                    value_node = cell.find("m:v", NS)
                    inline = cell.find("m:is", NS)
                    if cell.attrib.get("t") == "s" and value_node is not None:
                        value = strings[int(value_node.text)]
                    elif cell.attrib.get("t") == "inlineStr" and inline is not None:
                        value = "".join(inline.itertext())
                    else:
                        value = value_node.text if value_node is not None else None
                    cells[column_index(cell.attrib["r"])] = value
                rows.append([cells.get(i) for i in range(max(cells, default=-1) + 1)])
            return rows
    raise ValueError(f"No se encontró la hoja {SOURCE_SHEET!r}.")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Uso: python3 scripts/import-facturas-2026.py /ruta/Facturas\\ Emitidas.xlsx")
    rows = load_workbook(Path(sys.argv[1]))
    records = []
    for row_number, row in enumerate(rows[6:], start=7):
        if len(row) < 2 or row[1] in (None, ""):
            continue
        row += [None] * max(0, 24 - len(row))
        records.append({
            "id": f"facturas-emitidas-2026-{row_number}", "invoiceNumber": text(row[1]),
            "year": int(float(row[2])) if row[2] else None, "month": text(row[3]),
            "issueDate": excel_date(row[4]), "documentType": text(row[5]), "issuer": text(row[6]),
            "issuerRut": text(row[7]), "client": text(row[8]), "recipient": text(row[9]),
            "recipientRut": text(row[10]), "netAmount": number(row[11]), "vatAmount": number(row[12]),
            "totalAmount": number(row[13]), "notes": text(row[14]), "paymentTermDays": number(row[15]),
            "dueDate": excel_date(row[16]), "dueMonth": text(row[17]), "status": text(row[18]),
            "paymentDate": excel_date(row[19]), "paymentMethod": text(row[20]),
            "originAccountRut": text(row[21]), "destinationBank": text(row[22]),
            "destinationAccount": text(row[23]),
            "source": {"file": Path(sys.argv[1]).name, "sheet": SOURCE_SHEET, "row": row_number},
        })
    type_definition = """export type InvoiceRecord = {\n  id: string; invoiceNumber: string | null; year: number | null; month: string | null; issueDate: string | null; documentType: string | null; issuer: string | null; issuerRut: string | null; client: string | null; recipient: string | null; recipientRut: string | null; netAmount: number | null; vatAmount: number | null; totalAmount: number | null; notes: string | null; paymentTermDays: number | null; dueDate: string |null; dueMonth: string | null; status: string | null; paymentDate: string | null; paymentMethod: string | null; originAccountRut: string | null; destinationBank: string | null; destinationAccount: string | null; source: { file: string; sheet: string; row: number };\n};\n\n"""
    destination = Path("src/data/facturas-emitidas-2026.ts")
    destination.write_text("// Archivo generado desde el libro fuente; no editar valores manualmente.\n" + type_definition + f"export const facturasEmitidas2026: InvoiceRecord[] = {json.dumps(records, ensure_ascii=False, indent=2)};\n")
    print(f"{len(records)} registros escritos en {destination}")


if __name__ == "__main__":
    main()
