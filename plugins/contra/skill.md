# Contra authenticated opportunities

This plugin is cache-backed. To refresh it, open Contra in an authenticated
browser session and run:

```bash
node marketplace.mjs sync --source contra --write
```

The ingest hook only reads `data/contra-recommendations.json`; it does not
apply, save, message, or submit.
