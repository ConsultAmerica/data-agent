"""Recognition providers: the contract every OCR/layout/field engine meets
(types.py), the policy that decides which engine may see which document
(policy.py), and the run log of what was sent where (runs.py).

See docs/di-01-target-architecture.md §3–§4. Today the only external
engines are the LLM providers behind AIEnrichmentSession; local steps
(native text, Tesseract, source structure) are unchanged and are wrapped
into this contract incrementally.
"""
