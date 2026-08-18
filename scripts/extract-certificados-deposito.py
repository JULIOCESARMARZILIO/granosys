import json
import re
import sys
from pathlib import Path

import pdfplumber


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def first(pattern, text):
    match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
    return clean(match.group(1)) if match else None


def parse_pdf(path):
    with pdfplumber.open(path) as pdf:
        text = "\n".join((page.extract_text() or "") for page in pdf.pages)

    coe = first(r"C\.O\.E\.\s*:\s*(\d{12})", text) or path.stem
    grain = first(r"Grano y Tipo:\s*(.+?)\s+C\.O\.E\.", text)
    section = text
    if "GRANOS" in text:
        section = text.split("GRANOS", 1)[1]
    if "PESO SERVICIOS" in section:
        section = section.split("PESO SERVICIOS", 1)[0]
    ctgs = sorted(set(re.findall(r"\b10\d{9}\b", section)))
    cuits = list(dict.fromkeys(re.findall(r"C\.U\.I\.T\.\s*:\s*(\d{11})", text)))

    return {
        "coe": coe,
        "fecha_emision": first(r"Fecha Emisi.n:\s*(\d{2}/\d{2}/\d{4})", text),
        "tipo_certificado": first(r"Tipo de certificado:\s*(.+?)\s+Campa.a:", text),
        "campana": first(r"Campa.a:\s*([^\n]+)", text),
        "grano_tipo": grain,
        "planta": first(r"PLANTA NRO:\s*(\d+)", text),
        "cuits": cuits,
        "ctgs": ctgs,
        "pdf": str(path.resolve()),
        "paginas": text.count("Firma del Depositario Firma del Depositante"),
    }


def main():
    source = Path(sys.argv[1])
    output = Path(sys.argv[2])
    records = [parse_pdf(path) for path in sorted(source.glob("*.pdf"))]
    output.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "certificados": len(records),
        "con_ctg": sum(bool(item["ctgs"]) for item in records),
        "ctg_relaciones": sum(len(item["ctgs"]) for item in records),
        "ctg_unicos": len({ctg for item in records for ctg in item["ctgs"]}),
        "sin_ctg": [item["coe"] for item in records if not item["ctgs"]],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()

