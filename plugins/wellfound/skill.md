# Wellfound authenticated opportunities

This plugin is cache-backed. To refresh it, open Wellfound in an authenticated
browser session and run:

```bash
node marketplace.mjs sync --source wellfound --write
```

The ingest hook only reads `data/wellfound-recommendations.json`; it does not
apply, save, message, or submit.
