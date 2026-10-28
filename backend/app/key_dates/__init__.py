"""Key dates and expiry detection for any document
(docs/di-04-intelligent-document-architecture.md §5).

detector.py finds dated events (expiry, validity end, renewal,
termination, period end, due, issue, effective) from three sources, in
order of trust: a machine-readable zone (passports, visas, ID cards), the
contract schedule (period-of-performance ends) and labelled dates in the
page text. service.py persists them per document when it is staged and
computes status (expired / expiring soon / active) on read.
"""
