"""Check-digit algorithms for identifiers printed on documents."""

from __future__ import annotations

import re


def luhn_valid(digits: str) -> bool:
    """Luhn (mod 10) — card numbers, NPI (with prefix), many ids."""

    if not re.fullmatch(r"\d{2,}", digits or ""):
        return False
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char)
        if index % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def npi_valid(npi: str) -> bool:
    """US National Provider Identifier: 10 digits, Luhn over the ISO
    prefix 80840 + the number."""

    npi = (npi or "").strip()
    return bool(re.fullmatch(r"\d{10}", npi)) and luhn_valid("80840" + npi)


def aba_routing_valid(routing: str) -> bool:
    """US ABA routing transit number: 9 digits,
    3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10)."""

    routing = (routing or "").strip()
    if not re.fullmatch(r"\d{9}", routing):
        return False
    d = [int(c) for c in routing]
    total = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])
    return total % 10 == 0


def aba_prefix_plausible(routing: str) -> bool:
    """First two digits in a range the Federal Reserve assigns
    (00–12 government/Federal Reserve districts, 21–32 thrift,
    61–72 electronic, 80 traveller's cheques)."""

    if not re.fullmatch(r"\d{9}", (routing or "").strip()):
        return False
    prefix = int(routing[:2])
    return prefix <= 12 or 21 <= prefix <= 32 or 61 <= prefix <= 72 or prefix == 80


# ISO 13616 IBAN lengths for common countries. A country not listed is
# checked by mod-97 only.
IBAN_LENGTHS: dict[str, int] = {
    "AD": 24, "AE": 23, "AT": 20, "BE": 16, "BG": 22, "CH": 21, "CY": 28,
    "CZ": 24, "DE": 22, "DK": 18, "EE": 20, "ES": 24, "FI": 18, "FR": 27,
    "GB": 22, "GR": 27, "HR": 21, "HU": 28, "IE": 22, "IS": 26, "IT": 27,
    "LI": 21, "LT": 20, "LU": 20, "LV": 21, "MC": 27, "MT": 31, "NL": 18,
    "NO": 15, "PL": 28, "PT": 25, "RO": 24, "SA": 24, "SE": 24, "SI": 19,
    "SK": 24, "SM": 27, "TR": 26,
}


def iban_valid(iban: str) -> bool:
    """ISO 13616: country length (when known) and mod-97 == 1."""

    compact = re.sub(r"\s+", "", iban or "").upper()
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{10,30}", compact):
        return False
    expected = IBAN_LENGTHS.get(compact[:2])
    if expected is not None and len(compact) != expected:
        return False
    rearranged = compact[4:] + compact[:4]
    numeric = "".join(str(int(char, 36)) for char in rearranged)
    return int(numeric) % 97 == 1
