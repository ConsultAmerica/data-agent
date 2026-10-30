import asyncio
from types import SimpleNamespace

from app.services.ai_provider import DisabledAIProvider
from app.services.schema_discovery import discover_document_schema
from app.services.structure_detection import detect_document_structures


def _page(
    *,
    number: int,
    text: str,
    tables: list[dict] | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        page_number=number,
        final_text=text,
        tables_json=tables or [],
        form_fields_json={},
    )


def _document() -> SimpleNamespace:
    return SimpleNamespace(
        id="doc-test",
        original_filename="solicitation.pdf",
    )


async def _detect(text: str, tables: list[dict] | None = None):
    return await detect_document_structures(
        document=_document(),
        pages=[_page(number=1, text=text, tables=tables)],
        ai_provider=DisabledAIProvider(),
    )


async def _discover(text: str, tables: list[dict] | None = None):
    return await discover_document_schema(
        document=_document(),
        pages=[_page(number=1, text=text, tables=tables)],
        ai_provider=DisabledAIProvider(),
    )


def _assert_no_pricing_or_rate_card(targets) -> None:
    keys = {target.key for target in targets}
    labels = {target.label for target in targets}
    assert "rate_card" not in keys
    assert "pricing_table" not in keys
    assert "Rate Card" not in labels
    assert "Pricing Table" not in labels


def test_gov_contract_without_pricing_does_not_surface_rate_card_or_pricing_table() -> None:
    text = (
        "SOLICITATION NO.  W912HQ-24-R-0001\n"
        "CONTRACT NO.  W912HQ-24-C-0001\n"
        "NAICS  541512\n"
        "PSC CD  R499\n"
        "MAX NET AMT  $500,000.00\n"
        "Schedule of supplies/services for CLIN 0001 with unit prices."
    )
    tables = [
        {
            "headers": ["Labor Category", "Hourly Rate", "Hours"],
            "rows": [{"Labor Category": "Senior Analyst", "Hourly Rate": "$150", "Hours": "100"}],
        }
    ]

    detection = asyncio.run(_detect(text, tables))
    all_detected = detection.detected_targets + detection.possible_targets
    _assert_no_pricing_or_rate_card(all_detected)

    schema = asyncio.run(_discover(text, tables))
    _assert_no_pricing_or_rate_card(schema.targets)


def test_gov_form_labels_are_discoverable() -> None:
    text = (
        "SOLICITATION NO.  W912HQ-24-R-0001\n"
        "CONTRACT NO.  W912HQ-24-C-0001\n"
        "DODAAC  W58RGZ\n"
        "CAGE  1ABC2\n"
        "WAWF Payment Office routing data follows."
    )

    schema = asyncio.run(_discover(text))

    keys = {target.key for target in schema.targets}
    labels = {target.label.lower() for target in schema.targets}

    assert "solicitation_number" in keys or any("solicitation" in label for label in labels)
    assert "contract_no" in keys or "contract_number" in keys or any(
        "contract no" in label for label in labels
    )
    assert "dodaac" in keys or any("dodaac" in label for label in labels)


def test_toc_dotted_leaders_are_not_discovered_as_business_fields() -> None:
    text = (
        "TABLE OF CONTENTS\n"
        "ATTACHMENT J-1 ........................ 69\n"
        "ATTACHMENT J-2 ........................ 72\n"
        "ATTACHMENT J-10 ....................... 122\n"
        "SECTION B ..................... 9\n"
    )

    schema = asyncio.run(_discover(text))

    keys = {target.key for target in schema.targets}
    values = {
        " ".join(str(e) for e in target.source_examples).lower()
        for target in schema.targets
    }

    assert "kv_attachment_j_1" not in keys
    assert "kv_attachment_j_2" not in keys
    assert "kv_attachment_j_10" not in keys
    assert not any("........" in value for value in values)


def test_clause_citation_reference_is_not_discovered_as_a_business_field() -> None:
    text = (
        "FAR 16 clause reference: 505(b)(6), Post-award Notices and Debriefings\n"
    )

    schema = asyncio.run(_discover(text))

    keys = {target.key for target in schema.targets}
    assert "kv_far_16" not in keys


def test_ucf_section_heading_and_form_noise_are_not_discovered_as_fields() -> None:
    text = (
        "E. Inspection and Acceptance: All items must pass final inspection.\n"
        "Address: (Type or print)\n"
        "Area Code Number: EXT.\n"
        "CLIN: DESCRIPTION OF SUPPLIES/SERVICES AMOUNT\n"
        "Government: Government property includes both Government-furnished "
        "and contractor-acquired property necessary to perform this contract.\n"
        "Contract Number: 47QRCA25DSF07\n"
    )

    schema = asyncio.run(_discover(text))

    keys = {target.key for target in schema.targets}
    assert "kv_e_inspection_and_acceptance" not in keys
    assert "kv_address" not in keys
    assert "kv_area_code_number" not in keys
    assert "kv_clin" not in keys
    assert "kv_government" not in keys
    assert "contract_number" in keys


def test_value_repeated_across_unrelated_sow_headings_is_not_promoted() -> None:
    """P0 regression: a value that keeps showing up next to SOW/PWS topic
    headings in flattened page text (a column/reading-order artifact, not
    a real label:value pair) must not be promoted N times as N different
    business fields — "Firm Fixed Price" attached to "Accident
    Prevention", "Airfield Operations", and "Asset Management" alike."""

    text = (
        "ACCIDENT PREVENTION\n"
        "Firm Fixed Price\n"
        "\n"
        "AIRFIELD OPERATIONS\n"
        "Firm Fixed Price\n"
        "\n"
        "ASSET MANAGEMENT\n"
        "Firm Fixed Price\n"
        "\n"
        "Pricing Arrangement:  Firm Fixed Price\n"
        "Contract Number: 47QRCA25DSF07\n"
    )

    detection = asyncio.run(_detect(text))
    all_detected = detection.detected_targets + detection.possible_targets
    keys = {target.key for target in all_detected}

    assert "kv_accident_prevention" not in keys
    assert "kv_airfield_operations" not in keys
    assert "kv_asset_management" not in keys

    schema = asyncio.run(_discover(text))
    business_keys = {target.key for target in schema.targets}
    assert "kv_accident_prevention" not in business_keys
    assert "kv_airfield_operations" not in business_keys
    assert "kv_asset_management" not in business_keys
    # The single genuine label:value pair (inline, real structure) survives.
    assert "kv_pricing_arrangement" in business_keys
    assert "contract_number" in business_keys


def test_line_item_columns_are_not_flattened_into_document_fields() -> None:
    """P0 regression: a CLIN/line-item table's own column values ("Unit
    Price", "Amount", "Quantity") must not leak into document-level
    business fields just because the same text also appears, unlabeled,
    in the page's flattened text next to the table."""

    text = (
        "SECTION B - SUPPLIES OR SERVICES AND PRICES\n"
        "CLIN\n0001\nDESCRIPTION\nEngineering Services\nQTY\n1\nUNIT\nLOT\n"
        "UNIT PRICE\n$94,469.80\nAMOUNT\n$94,469.80\n"
        "CLIN\n0002\nDESCRIPTION\nSupport Services\nQTY\n12\nUNIT\nMO\n"
        "UNIT PRICE\n$5,000.00\nAMOUNT\n$60,000.00\n"
        "Contract Number: 47QRCA25DSF07\n"
    )
    tables = [
        {
            "headers": ["CLIN", "Description", "Qty", "Unit", "Unit Price", "Amount"],
            "rows": [
                {
                    "CLIN": "0001",
                    "Description": "Engineering Services",
                    "Qty": "1",
                    "Unit": "LOT",
                    "Unit Price": "$94,469.80",
                    "Amount": "$94,469.80",
                },
                {
                    "CLIN": "0002",
                    "Description": "Support Services",
                    "Qty": "12",
                    "Unit": "MO",
                    "Unit Price": "$5,000.00",
                    "Amount": "$60,000.00",
                },
            ],
        }
    ]

    schema = asyncio.run(_discover(text, tables))
    keys = {target.key for target in schema.targets}

    assert "amount" not in keys
    assert "kv_unit_price" not in keys
    assert "kv_quantity" not in keys
    assert "contract_number" in keys
    # The real line-item data still exists, just as a table, not scalars.
    assert any(target.target_type == "table" for target in schema.targets)


def test_contract_schedule_rows_are_not_document_fields() -> None:
    """FA30's CLIN schedule: each service line prints its pricing type or
    its amount after the service name. Those are line items, not fields —
    while the header's own label/value pairs stay."""

    text = (
        "Contract Number: FA300224C0008\n"
        "Pricing Arrangement: Firm Fixed Price\n"
        "All Services: Firm Price\n"
        "Vehicles: Firm Price\n"
        "Resource Management: Firm Price\n"
        "Maintenance Foreign Object: Firm Price\n"
        "Damage: USD 97,003.20\n"
        "Maintenance: USD 364,628.80\n"
        "Support: USD 79,661.50\n"
        "Total Amount: USD 541,293.50\n"
    )
    detection = asyncio.run(_detect(text))
    fields = {target.key for target in detection.detected_targets if target.key.startswith("kv_")}
    for row in ("kv_all_services", "kv_vehicles", "kv_damage", "kv_maintenance", "kv_support"):
        assert row not in fields
    assert {"kv_pricing_arrangement", "kv_total_amount"} <= fields
