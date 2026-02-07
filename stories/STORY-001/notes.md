# STORY-001 — Notes

## Design decisions
- **Local-first, single-user (MVP):** Ingen auth första versionen. Skydda via att köra på eget nät / senare auth.
- **Strukturerad LLM-output:** Analysresultat ska vara strikt JSON som valideras server-side (för att UI ska vara stabilt).
- **Separation of concerns:** Import → Normaliserad portfölj → (ev.) Marknadsdata → Analys → Rapport.
- **Scheduler som del av backend:** Nattlig analys körs i samma process initialt (enklast). Vid deployment kan det senare flyttas till cron/worker.

### Rekommenderad första stack (enkel, snabb att få klar)
Antagande (kan ändras): du vill ha något som är lätt att köra lokalt och även hosta senare.

- **Backend:** Node.js + TypeScript + Fastify (snabbt, enkelt API) + `node-cron`
- **DB:** SQLite (via Prisma) för portfolio/strategy/thesis/analysis runs
- **UI:** React + Vite + Tailwind (mobilvänligt snabbt)
- **CSV-parsing:** `papaparse` eller `csv-parse`
- **OpenAI:** official SDK, körs endast i backend

Alternativ om du föredrar Python:
- FastAPI + SQLModel/SQLAlchemy + APScheduler + Jinja/React separat

## Alternatives considered
- **Direkt Avanza API-integration:** mer “rätt” men svårare (auth, stabilitet). CSV startar enklare.
- **Multi-user/auth tidigt:** skjuts upp för att snabbare få nytta.
- **Komplex marknadsdata tidigt:** börja med stub/mock så att analys-pipeline och UI kan byggas end-to-end.

## Risks
- **LLM-kostnad/latens:** Mitigera med caching, begränsat token-innehåll, och nattlig körning.
- **Prompt drift / instabilt output:** Mitigera med JSON-schema + validering + fallback.
- **Känslig data:** portföljuppgifter ska inte läcka i logs; maska vid behov.
- **Scheduler-dubbelkörning:** Mitigera med singleflight/lås i DB.
