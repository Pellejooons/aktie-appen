# Aktie_bmad

Det här repo:t är bootstrappat för **BMAD (agent-baserad) utveckling**: story → tasks → implementation → QA.

## Snabbstart

Skapa en ny story:

```zsh
./scripts/bmad-create-story STORY-001 "Kort titel" \
  --goal "Vad ska uppnås" \
  --context "Kort kontext"
```

Det skapar en mapp under `stories/STORY-001/` med:
- `story.md` (krav + acceptanskriterier)
- `tasks.md` (todo/checklista)
- `notes.md` (designbeslut)
- `qa.md` (testplan + checks)

## Hur du jobbar (rekommenderat flöde)

1. Fyll i `stories/<id>/story.md`.
2. Bryt ner till uppgifter i `stories/<id>/tasks.md`.
3. Implementera i valfritt språk/projekt.
4. Uppdatera `qa.md` och kör relevanta quality gates (build/lint/tests).

## Arbetskommandon (för AI-agenten)

Se `.bmad/workflows/create-story.md` för formatet som agenten följer.

## TLS (HTTPS) via reverse proxy (Caddy)

För TLS mellan webbläsare och server: kör Fastify-backenden på vanlig HTTP (default `:3000`) och lägg Caddy framför.

### Lokal dev (rekommenderat)

1. Installera Caddy.
2. Lägg till en lokal host:
  - Lägg in `127.0.0.1 aktie.local` i `/etc/hosts`.
3. Använd `Caddyfile` i repo-roten.
4. Starta backend (HTTP):
  - `npm run dev`
5. Starta Caddy (HTTPS):
  - `caddy run`
6. Lita på den lokala CA:n (engångs per dator) så webbläsaren accepterar certet:
  - `caddy trust`

Öppna sedan: `https://aktie.local`

### LAN-access från mobil (valfritt)

Vill du öppna appen från mobilen på samma Wi-Fi kan du använda den IP-baserade blocket i `Caddyfile` (med `tls internal`).
Notera: du behöver lita på certet på mobilen.
