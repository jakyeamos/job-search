# Modo: pipeline — Inbox de URLs (Second Brain)

Procesa URLs de ofertas acumuladas en `data/pipeline.md`. El usuario agrega URLs cuando quiera y luego ejecuta `/career-ops pipeline` para procesarlas todas.

## Workflow

1. **Leer** `data/pipeline.md` → buscar items `- [ ]` en la sección "Pendientes"
2. **Liveness sweep** -- para cada URL pendiente:
   a. Check `node pipeline-liveness-cache.mjs status <url>` first. If it returns a live browser-policy/browser-unavailable cache entry, skip only the repeated browser attempt and continue to Codex-native WebFetch → WebSearch. The cache is batch-only and never proves liveness.
   b. Otherwise, **extraer JD** using Playwright (browser_navigate + browser_snapshot) → WebFetch → WebSearch.
   c. If Playwright is blocked by the active browser safety policy, record it with `node pipeline-liveness-cache.mjs record <url> --reason "..."`, then use Codex-native WebFetch and WebSearch as the headless batch fallback. Do not stop the batch solely because Firecrawl is unavailable.
   d. Fallback content may support provisional triage/evaluation, but every resulting report must include `**Verification:** unconfirmed (batch fallback: browser/Firecrawl unavailable)`. It is not proof that the posting is currently live; manually verify promising roles before applying.
   e. Si la URL no es accesible and no usable JD can be recovered → marcar como `- [!]` con nota y continuar (no entra al triage gate).
3. **Two-Pass Triage Gate** (see below) -- runs on every URL that survived the liveness sweep.
4. **Para cada URL que pasó el triage gate** (PASS or MARGINAL):
   a. Calcular siguiente `REPORT_NUM` secuencial (leer `reports/`, tomar el número más alto + 1)
   b. **Discovery default:** follow `modes/discovery-card.md` → compact report .md → Tracker. Do not load or run the full A-G evaluation while clearing the discovery queue. Run `/career-ops oferta {report-or-url}` only after the user shortlists a role.
   c. Do not generate tailored HTML or PDF artifacts while clearing the discovery queue; create resume artifacts later with `/career-ops pdf {company-slug}` for roles the user selects.
   d. **Mover de "Pendientes" a "Procesadas"**: `- [x] #NNN | URL | Empresa | Rol | Score/5 | PDF ❌`
5. **Si hay 3+ URLs en la fase de evaluación completa**, lanzar agentes en paralelo (Agent tool con `run_in_background`) para maximizar velocidad.
6. **Al terminar**, mostrar tabla resumen:

```
| # | Empresa | Rol | Score | PDF | Acción recomendada |
```

**Discovery performance policy:** controlled queue batches use `pipeline-fast-pass.mjs`,
deterministic filtering, and `modes/discovery-card.md`. Full A-G context and
tailored HTML/PDF generation are on-demand follow-ups for shortlisted roles.

## Two-Pass Triage Gate (token efficiency)

**Trigger:** 5+ URLs survived the liveness sweep. Controlled queue runs should use this gate for every normal batch (the queue runner's default work unit is 10 URLs).

Below that threshold, skip straight to step 4 (compact decision card) for every surviving URL -- the triage overhead isn't worth it on small batches.

**When triggered:**

1. Launch one triage agent per surviving URL in parallel (Agent tool, `run_in_background`), each following `modes/triage.md`. Each agent reads only `modes/_brief.md` (~15K tokens) instead of the full context stack (~65K tokens for a full A-G evaluation).
2. Collect the `TRIAGE | ...` line each agent returns.
3. Show the triage summary table before doing anything else:

```
| # | Empresa | Rol | Triage Score | Verdict | Reason |
```

4. Route by verdict:
   - **PASS** (score >= 4.0): proceed automatically to step 4 (compact decision card).
   - **MARGINAL** (3.8-3.9): write a compact decision card marked MARGINAL; do not run the full A-G evaluation.
   - **FAIL** (< 3.8) or **SKIP** (JD unreachable / hard DQ): do NOT run a full evaluation. No report, no PDF. Write a tracker TSV entry directly (`batch/tracker-additions/`) with status `SKIP`, the triage score, report column `—`, and a note prefixed `Triage:` followed by the reason. Move the pipeline.md line straight to "Procesadas" noting the triage score, e.g. `- [x] URL | Empresa | Rol | 2.5/5 (triage) | SKIP`.

The fast runner prefetches and filters locally, then one persistent Codex worker
reads only the surviving manifest items plus `modes/_brief.md`. PASS/MARGINAL
roles produce compact cards; no role loads the full A-G stack during discovery.

## Formato de pipeline.md

```markdown
## Pendientes
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [!] https://private.url/job — Error: login required

## Procesadas
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

## Detección inteligente de JD desde URL

1. **Playwright (preferido):** `browser_navigate` + `browser_snapshot`. Funciona con todas las SPAs.
2. **WebFetch (fallback):** Para páginas estáticas o cuando Playwright no está disponible.
3. **WebSearch (último recurso):** Buscar en portales secundarios que indexan el JD.

**Fallback de eficiencia:** Firecrawl es opcional. Cuando no haya créditos o el navegador bloquee un dominio, WebFetch/WebSearch nativos de Codex mantienen el procesamiento en marcha con procedencia `unconfirmed`; no usar otro procesador de pago ni intentar eludir la restricción del dominio.

**Browser-failure cache:** `pipeline-liveness-cache.mjs` stores only short-lived, host-scoped observations that the browser surface was blocked or unavailable. It suppresses a repeated browser attempt for up to four hours, then expires automatically. Never use it to mark a role active or to remove the manual verification requirement.

**Casos especiales:**
- **LinkedIn**: Puede requerir login → marcar `[!]` y pedir al usuario que pegue el texto
- **PDF**: Si la URL apunta a un PDF, leerlo directamente con Read tool
- **`local:` prefix**: Leer el archivo local. Ejemplo: `local:jds/linkedin-pm-ai.md` → leer `jds/linkedin-pm-ai.md`

## Numeración automática

1. Listar todos los archivos en `reports/`
2. Extraer el número del prefijo (e.g., `142-medispend...` → 142)
3. Nuevo número = máximo encontrado + 1

## Sincronización de fuentes

Antes de procesar cualquier URL, verificar sync:
```bash
node cv-sync-check.mjs
```
Si hay desincronización, advertir al usuario antes de continuar.
