

def test_identifier_fields_reject_words_from_prose():
    from app.services.label_rejection import is_word_not_identifier, reject_as_field_value

    # "Contract Number: assigned." on a special-requirements page (SF1442 p.30).
    assert reject_as_field_value("assigned.", value_type="contract_number") == "identifier_is_a_word"
    assert is_word_not_identifier("assigned.")
    # Real identifiers and upper-case codes are kept.
    assert is_word_not_identifier("point of contact.")
    # Real identifiers, upper-case codes and the form's own placeholder
    # statements (SF1442 DODAAC blocks) are kept.
    for value in ("N4019223D2803", "W91ZZZ26C0042", "N/A", "SB-DBMACC", "0011734552-0001",
                  "Specified on task order", "Not Applicable"):
        assert not is_word_not_identifier(value), value
    assert reject_as_field_value("N4019223D2803", value_type="contract_number") is None


def test_validation_fails_a_word_in_an_identifier_field():
    from app.services.result_validation import build_validation_result

    result = build_validation_result(
        value="assigned.", value_type="contract_number",
        source_text="Contract Number: assigned.", page_text="Contract Number: assigned.",
    )
    data_type = next(check for check in result.checks if check.type == "data_type")
    assert data_type.status == "failed"


# Discovered label/value pairs from the SF1442 award that were stored at
# 0.99 confidence: each is a label, a footer, or a backwards/split pairing.
_JUNK_PAIRS = [
    ("cage_code", "0001", "cage_code_shape"),
    ("kv_code", "FACILITY CODE", "value_is_a_label"),
    ("kv_tel", "FAX:                                 TEL:", "value_is_labels_only"),
    ("kv_n4019221r28000019", "1 OF  33", "label_is_an_identifier"),
    ("kv_n4019223d2803", "ACQR5858342", "label_is_an_identifier"),
    ("kv_nsn_7540_01_155_3212", "1442- 101   STANDARD FORM 1442", "form_footer"),
    ("kv_regulation_52", "216-7, Allowable Cost and Payment, as applicable.", "split_clause_citation"),
]

_REAL_PAIRS = [
    ("kv_fob", "Destination"),
    ("kv_max", "$600,000,000.00"),
    ("kv_ship_to_code", "Specified on task order"),
    ("kv_call", "DORIS CASTRO 671-339-8465"),
    ("cage_code", "1ABC2"),
    ("kv_purchase_request_number", "ACQR5858342"),
    ("kv_automobile_liability", "$200,000 per person, $500,000 per occurrence"),
    ("psc_cd", "Z1AZ"),
    ("kv_option", "First Option Period - SB-DBMACC"),
    ("contract_number", "N4019223D2803"),
    ("kv_dodaac", "N40192"),
    ("kv_admin", "DCMA Code: S0512A"),
]


def test_junk_pairs_are_rejected_with_a_reason():
    import pytest  # noqa: F401 - keep the module importable without pytest at top

    from app.services.label_rejection import reject_as_field_value

    for key, value, reason in _JUNK_PAIRS:
        assert reject_as_field_value(value, value_type="string", field_key=key) == reason, key


def test_real_pairs_are_kept():
    from app.services.label_rejection import reject_as_field_value

    for key, value in _REAL_PAIRS:
        assert reject_as_field_value(value, value_type="string", field_key=key) is None, (key, value)
