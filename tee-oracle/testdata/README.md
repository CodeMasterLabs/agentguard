# Test fixtures, not credentials

`quote.json` is a captured NEAR Intents (1Click) quote used by the tee-oracle tests. Everything
in it is public material:

- `manager` — the **public** key that signs quotes. The matching secret belongs to the service,
  not to this repository.
- `hash` — the quote hash the oracle recomputes and checks.
- `quote.signature` — a signature *over* the quote. A signature is not a key and cannot be used
  to sign anything else.

No private key, seed or bearer token lives here. Tests only verify that the oracle recomputes the
hash and checks the signature against the manager key above, so a scanner seeing a long base58
string in this file is looking at a signature.
