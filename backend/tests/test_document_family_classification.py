"""Keyword family classification labels common business and personal
documents from their own printed text (no AI, no filename)."""

import pytest

from app.services.structure_detection import classify_document_family

SAMPLES = {
    "invoice": "INVOICE\nInvoice Number: INV-1\nInvoice Date: 1/1/2026\nBill To: Acme\nAmount Due $100",
    "pay_stub": (
        "ACME CORP EARNINGS STATEMENT\nPay Period: 03/01-03/15\nPay Date 03/20\n"
        "Gross Pay 2,000.00 Net Pay 1,540.00\nFederal Income Tax 200 Social Security 124 Medicare 29"
    ),
    "bank_check": (
        "First National Bank\nPAY TO THE ORDER OF John Smith $1,299.99\nVOID AFTER 90 DAYS\n"
        "Authorized Signature\n⑆021000021⑆ 123456789⑈ 1001"
    ),
    "receipt": (
        "Sales Receipt\nItem 1 4.99\nSubtotal 4.99 Tax 0.40 Total 5.39\n"
        "Cash Tendered 10.00 Change Due 4.61\nThank you for your purchase"
    ),
    "passport": (
        "PASSPORT\nType/Type P Passport No. 123456789\nSurname DOE Given Names JOHN\n"
        "Nationality UNITED STATES\nPlace of Birth TEXAS\nDate of Expiry 01 JAN 2030"
    ),
    "academic_transcript": (
        "OFFICIAL TRANSCRIPT\nOffice of the Registrar\nFall 2023 Credits Attempted 15 "
        "Credits Earned 15 Term GPA 3.5\nCumulative GPA 3.6"
    ),
    "contract": "This Agreement is made by the parties as of the Effective Date. WHEREAS ... Governing Law: New York.",
    "tax_form": "Form W-2 Wage and Tax Statement 2025\nEmployer identification number 12-3456789",
    "statement": "Statement Period 01/01 - 01/31\nBeginning Balance 1,000 Ending Balance 1,200\nTotal Deposits 500",
    "utility_bill": "Service Address 1 Main St\nMeter Number 4471\nPrevious Reading 100 Current Reading 450 kWh",
    "driving_licence": "STATE OF TEXAS DRIVER LICENSE\nLicense Class C\nDOB 01/01/1990\nRestrictions NONE",
    "identity_card": "REPUBLIC OF UTOPIA\nNATIONAL IDENTITY CARD\nCard Number 123456789",
    "shipping_document": "BILL OF LADING\nShipper: Acme\nConsignee: Beta Corp\nPacking List attached",
    "credit_note": "CREDIT NOTE\nCredit Memo CN-22 against invoice INV-9",
    "quotation": "QUOTATION\nQuote Number Q-17\nValid Until 30 Nov 2026",
    "resume": "JANE DOE\nProfessional Summary\nWork Experience\nTechnical Skills: Python",
}


@pytest.mark.parametrize(("family", "text"), SAMPLES.items())
def test_documents_are_labelled_by_their_own_text(family, text) -> None:
    assert classify_document_family(text)[0] == family


def test_a_plain_letter_is_not_forced_into_a_type() -> None:
    assert classify_document_family("Dear Sir, regarding the meeting. Sincerely, Bob")[0] == "unknown"


def test_single_generic_words_do_not_decide_the_type() -> None:
    # "nationality" alone, or a cheque-like word, is not enough evidence.
    assert classify_document_family("Nationality of the vendor is listed below.")[0] != "passport"
    assert classify_document_family("A receipt was attached.")[0] != "receipt"


# --- field pairs on pay stubs and receipts ---------------------------------------------

from app.services.field_classification import is_narrative_or_section_field  # noqa: E402
from app.services.generic_kv_scanner import _scan_inline_regex  # noqa: E402


def _pairs(text: str) -> dict[str, str]:
    return {pair.raw_label: pair.value for pair in _scan_inline_regex(text)}


def test_a_decimal_point_does_not_split_a_label_from_its_amount() -> None:
    pairs = _pairs("Federal Income Tax 200.00\nNet Pay 1,647.00")
    assert pairs == {"Federal Income Tax": "200.00", "Net Pay": "1,647.00"}


def test_several_label_amount_pairs_on_one_line() -> None:
    pairs = _pairs("Subtotal 8.48 Tax 0.68 Total 9.16\nChange Due 10.84")
    assert pairs == {"Subtotal": "8.48", "Tax": "0.68", "Total": "9.16", "Change Due": "10.84"}


def test_prose_with_an_amount_is_not_a_field() -> None:
    assert _pairs("The amount payable is 500.00 per month.") == {}
    assert _pairs("Invoice No. INV-22") == {"Invoice No.": "INV-22"}


def test_money_amounts_are_values_but_paragraph_numbers_are_not() -> None:
    assert not is_narrative_or_section_field(key="kv_total", label="Total", value="9.16")
    assert not is_narrative_or_section_field(key="kv_change_due", label="Change Due", value="10.84")
    # Same shape under a non-money heading is still paragraph numbering.
    assert is_narrative_or_section_field(key="kv_scope", label="Scope", value="11.10")


def test_a_second_label_after_a_wide_gap_is_its_own_pair() -> None:
    pairs = _pairs("Employee: Jane Doe  Employee ID 4471\nShip To: 1 Main St  Suite 4")
    assert pairs == {"Employee": "Jane Doe", "Employee ID": "4471", "Ship To": "1 Main St  Suite 4"}


def test_a_heading_is_not_the_label_of_a_label_value_line() -> None:
    from app.services.generic_kv_scanner import _scan_stacked_lines

    assert _scan_stacked_lines("ACME CORP EARNINGS STATEMENT\nEmployee: Jane Doe") == []


def test_a_due_amount_is_money_not_a_date() -> None:
    from app.services.entity_classifier import classify_target_type

    assert classify_target_type("Change Due", "10.84") == "amount"
    assert classify_target_type("Balance Due", "$1,200.00") == "amount"
    assert classify_target_type("Due Date", "03/20/2026") == "date"


def test_a_caps_heading_before_a_label_value_pair_is_dropped() -> None:
    pairs = _pairs("FIRST NATIONAL BANK            Check No: 1001\nNAICS   541330")
    assert pairs == {"Check No.": "1001", "NAICS": "541330"}


def test_a_letter_greeting_is_not_a_field() -> None:
    assert _pairs("Dear Ms. Patel,") == {}


def test_a_gpa_is_a_value_not_a_paragraph_number() -> None:
    assert not is_narrative_or_section_field(key="kv_cumulative_gpa", label="Cumulative GPA", value="3.62")
