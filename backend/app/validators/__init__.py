"""Deterministic document validators (docs/di-01-validation-rules.md).

Every check here answers one question only: is the document internally
consistent and well-formed? A passport whose MRZ check digits pass is
consistent, not genuine; a routing number with a valid checksum is
well-formed, not an existing account. External verification is a
separate, consented integration — nothing in this package performs it or
may be labelled as it.

Values are never rewritten: validators read extracted values and report.
"""
