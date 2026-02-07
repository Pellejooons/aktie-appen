# STORY-001 — Tasks

## MVP-arkitektur (målbild)
- **Web UI (mobil först)**: dashboard + import + strategi/teser + rapportvy
- **Backend API**: tar emot CSV, normaliserar innehav, sparar data, kör analys
- **Scheduler**: nattlig analys (och manuell trigger via API)
- **Storage**: JSON-filer på disk (MVP), ev. DB senare
- **LLM**: OpenAI (server-side) med strikt JSON-schema för analysresultat

## Deliverables (MVP)
- [x] Repo har körbar dev-miljö (starta server, öppna UI)
- [x] CSV-import från Avanza → normaliserade innehav
- [x] CRUD för strategi + tes per aktie
- [x] Manuell analys: klick i UI → backend → OpenAI/mock → lagrad rapport → renderad
- [ ] Nattlig analys via scheduler
- [x] Grundläggande loggar + felhantering
- [x] Security: Basic Auth (enkelt login/lösen) + TLS via reverse proxy (Caddy)
- [x] Usage + performance: token-räknare (ungefär) + analys-timeout (default 60s)

## Nuvarande status (kort)
- Backend + UI finns i `apps/server/`.
- TLS körs via `Caddyfile` (reverse proxy).
- Auth via Basic Auth om `APP_USER`/`APP_PASSWORD` är satta.
- Usage via `/api/usage`.

## 1) Förarbete & kontrakt
- [ ] Definiera exakt CSV-format att stödja först
	- [ ] Spara ett exempel i `samples/avanza.csv` (maskera känsligt)
	- [ ] Lista obligatoriska kolumner (t.ex. instrument/namn, antal, ev. snittpris)
- [ ] Definiera domänmodeller (miniminivå):
	- [ ] `Holding` (ticker/name, quantity, avg_price?, currency?)
	- [ ] `Thesis` (ticker, text)
	- [ ] `Strategy` (text)
	- [ ] `AnalysisRun` (timestamp, status, inputs hash)
	- [ ] `Recommendation` (ticker, action, rationale, confidence, risks)
- [ ] Definiera API-kontrakt (första versionen)
	- [ ] `POST /api/import/avanza` (multipart CSV)
	- [ ] `GET /api/portfolio`
	- [ ] `PUT /api/strategy`
	- [ ] `PUT /api/thesis/{ticker}` + `GET /api/thesis`
	- [ ] `POST /api/analyze` (manual)
	- [ ] `GET /api/analysis/latest` + `GET /api/analysis/history`

## 2) Backend (import + lagring)
- [x] Skapa backend-projekt
- [x] Implementera CSV-parse + validering
	- [x] Fel vid saknade kolumner (returneras som 400 när inga holdings hittas)
	- [x] Hantera dubbletter och 0-antal
- [x] Implementera storage (JSON-filer) för portfolio, strategy, thesis, analysis runs
- [x] Endpoint: import + portfolio read

## 3) Marknadsdata (minsta möjliga)
- [ ] Implementera en “MarketDataProvider” interface
- [ ] Version 1: stub/mock som använder senaste pris = null eller hårdkodat
- [ ] (Optional) Integrera enkel kurskälla senare (se `notes.md`)

## 4) Analys (OpenAI)
- [x] Sätt upp OpenAI-klient (API key via `OPENAI_API_KEY`)
- [ ] Skapa prompt-template som inkluderar:
	- [ ] strategi
	- [ ] teser per aktie
	- [ ] innehav
	- [ ] (optional) index/marknadsdata
- [x] Definiera strikt JSON-schema för analysresultat
	- [x] Validera svar (och faila snyggt om fel)
- [x] Spara analysresultat + metadata
- [x] Endpoint: `POST /api/analyze` samt `GET latest/history`

## 5) Scheduler
- [ ] Lägg till nattlig körning (01:00 lokal tid)
- [ ] Säkerställ “no parallel runs” (single-flight / lås)
- [ ] Logga start/stop/status + duration
- [ ] Kunna stänga av scheduler via env: `SCHEDULER_ENABLED=0`

## 6) UI (mobilvänlig)
- [ ] Startvy: senaste analys + portföljöversikt
- [ ] Importvy: ladda upp CSV + visa preview
- [ ] Strategi/teser: editor-formulär
- [ ] Rapportvy: per aktie med action + motivering + confidence
- [ ] States: loading / error / empty portfolio
- [ ] Visa auth-fel (401) med tydligt meddelande (Basic Auth prompt i browser + text i UI)
- [ ] Visa timeout-fel från analysen tydligt
- [ ] Visa token-usage (ungefär) från `/api/usage`

## 7) Tester
- [ ] Unit: CSV-parser (happy path + saknad kolumn + dubblett)
- [ ] Unit: schema-validering av LLM-svar
- [ ] Integration/smoke: import → analyze (med mockad OpenAI)

## 8) Quality gates & docs
- [ ] Lint/format + typecheck (beroende på stack)
- [ ] README: hur man kör lokalt + env vars + exempel-CSV

## Nästa sprint (implementation steps)
1) Scheduler + single-flight + env-flagga
2) UI: usage-panel + bättre fel (401/timeout)

## Notes
- För att undvika att LLM “hallucinerar format”: kräv JSON-schema och kör strikt validering.
- Börja med mockad marknadsdata så du kan få end-to-end snabbt.
