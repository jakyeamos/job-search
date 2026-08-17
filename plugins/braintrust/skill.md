# Braintrust authenticated opportunities

This plugin is cache-backed. To refresh it, open Braintrust in an authenticated
browser session and run:

```bash
node marketplace.mjs sync --source braintrust --write
```

The ingest hook only reads `data/braintrust-recommendations.json`; it does not
apply, save, message, or submit.
