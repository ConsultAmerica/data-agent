"""Fictional supplier master and purchase orders for the invoice demo, in
the shape of POST /api/reference/suppliers and /purchase-orders. Mirrors
what an Oracle Procurement extract would provide."""

PO_FORMAT = r"PO-\d{10}"

SUPPLIERS = [
    {
        "supplier_number": "S-1001",
        "name": "Northwind Office Supply Company",
        "tax_id": "91-1234567",
        "sites": [
            {"site_code": "SEA-MAIN", "address": "1200 Harbor Way, Suite 400, Seattle, WA 98101", "business_unit": "US West BU"},
        ],
    },
    {
        "supplier_number": "S-2002",
        "name": "Contoso Laboratory Services",
        "sites": [{"site_code": "DEN-PAY", "address": "PO Box 7781, Denver, CO 80201", "business_unit": "US Central BU"}],
    },
    {
        "supplier_number": "S-3003",
        "name": "Fabrikam Furniture Partners",
        "sites": [{"site_code": "AUS-1", "address": "9 Elm Street, Austin, TX 78701", "business_unit": "US South BU"}],
    },
    {"supplier_number": "S-9000", "name": "Consult America Internal Services", "excluded_from_recognition": True, "sites": []},
]

PURCHASE_ORDERS = [
    {"po_number": "PO-4500012345", "supplier_number": "S-1001", "business_unit": "US West BU", "currency": "USD", "amount": 6000},
    {"po_number": "PO-4500012346", "supplier_number": "S-1001", "business_unit": "US West BU", "currency": "USD", "amount": 6000},
    {"po_number": "PO-4500099999", "supplier_number": "S-2002", "business_unit": "US Central BU", "currency": "USD"},
    {"po_number": "PO-4500000001", "supplier_number": "S-1001", "status": "closed"},
]
