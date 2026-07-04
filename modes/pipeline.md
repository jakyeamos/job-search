# Modo: pipeline — Inbox de URLs (Second Brain)

Procesa URLs de ofertas acumuladas en `data/pipeline.md`. El usuario agrega URLs cuando quiera y luego ejecuta `/career-ops pipeline` para procesarlas todas.

## Workflow

1. **Leer** `data/pipeline.md` → buscar items `- [ ]` en la sección "Pendientes"
2. **Liveness sweep** -- para cada URL pendiente:
   a. **Extraer JD** usando Playwright (browser_navigate + browser_snapshot) → WebFetch → WebSearch
   b. Si la URL no es accesible → marcar como `- [!]` con nota y continuar (no entra al triage gate)
3. **Two-Pass Triage Gate** (see below) -- runs on every URL that survived the liveness sweep.
4. **Para cada URL que pasó el triage gate** (PASS, or MARGINAL approved by the user):
   a. Calcular siguiente `REPORT_NUM` secuencial (leer `reports/`, tomar el número más alto + 1)
   b. **Ejecutar auto-pipeline completo**: Evaluación A-F → Report .md → PDF (si score >= 3.0) → Tracker
   c. **Mover de "Pendientes" a "Procesadas"**: `- [x] #NNN | URL | Empresa | Rol | Score/5 | PDF ✅/❌`
5. **Si hay 3+ URLs en la fase de evaluación completa**, lanzar agentes en paralelo (Agent tool con `run_in_background`) para maximizar velocidad.
6. **Al terminar**, mostrar tabla resumen:

```
| # | Empresa | Rol | Score | PDF | Acción recomendada |
```

## Two-Pass Triage Gate (token efficiency)

**Trigger:** 5+ URLs survived the liveness sweep.

Below that threshold, skip straight to step 4 (full evaluation) for every surviving URL -- the triage overhead isn't worth it on small batches.

**When triggered:**

1. Launch one triage agent per surviving URL in parallel (Agent tool, `run_in_background`), each following `modes/triage.md`. Each agent reads only `modes/_brief.md` (~15K tokens) instead of the full context stack (~65K tokens for a full A-G evaluation).
2. Collect the `TRIAGE | ...` line each agent returns.
3. Show the triage summary table before doing anything else:

```
| # | Empresa | Rol | Triage Score | Verdict | Reason |
```

4. Route by verdict:
   - **PASS** (score >= 4.0): proceed automatically to step 4 (full evaluation).
   - **MARGINAL** (3.8-3.9): hold. Ask the user whether to run the full evaluation on these before proceeding.
   - **FAIL** (< 3.8) or **SKIP** (JD unreachable / hard DQ): do NOT run a full evaluation. No report, no PDF. Write a tracker TSV entry directly (`batch/tracker-additions/`) with status `SKIP`, the triage score, report column `—`, and a note prefixed `Triage:` followed by the reason. Move the pipeline.md line straight to "Procesadas" noting the triage score, e.g. `- [x] URL | Empresa | Rol | 2.5/5 (triage) | SKIP`.

This means a batch of 10 URLs costs roughly 10 x 15K (triage) + N x 65K (full eval, only for PASSes) instead of 10 x 65K -- a 60-70% reduction when most URLs don't clear the bar.

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
