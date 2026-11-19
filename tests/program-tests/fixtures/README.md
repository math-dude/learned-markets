# Program-test fixtures

`solana_attestation_service.so` is the Solana Attestation Service program as
deployed on devnet at `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`, dumped
2026-11-19 with:

```sh
solana program dump -u devnet 22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG solana_attestation_service.so
```

sha256 `afacc7215d6ab6759bcf5edb958a1ad1d9de7559d53ac807c6aa4775a1a5a357`, 135 680 bytes.
Tests run the real issuer, schema, tokenization and revocation paths against it.
