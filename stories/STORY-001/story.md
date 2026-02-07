# STORY-001 — Mobil webbapp för aktieportfölj med Avanza-import och LLM-analys

## Goal
Bygga en mobilvänlig webbapp som jag kan surfa till från mobilen för att:
- ladda upp/importera mitt Avanza-innehav
- se portföljöversikt
- köra nattlig eller manuell analys som ger köp/sälj-/behåll-rekommendationer baserat på min strategi, mina investeringsteser och marknadsdata

## Context
Jag vill ha ett personligt verktyg för portföljstyrning. Analysen ska helst göras av en LLM och använda flera källor:
- mitt innehav (t.ex. antal, genomsnittspris, vikt)
- min portföljstrategi
- mina investeringsteser per aktie
- aktuella kurser och indexutveckling
- andra relevanta signaler (t.ex. nyheter/sentiment) — kan vara senare steg

## Contract (minimum viable)
### Inputs
- Avanza-export (antingen CSV/PDF/annan fil) som innehåller mina innehav
- Manuell input: strategi + tes per aktie (text)
- Marknadsdata: kurser/index (kan börja med mock/stub)

### Outputs
- Dashboard med portfölj + senaste analys
- Analysrapport per aktie + portföljnivå
- Tydlig rekommendation: `KÖP`, `SÄLJ`, `BEHÅLL` + motivering + osäkerhet

### Error modes
- Filformat stöds ej / saknar kolumner
- Tom portfölj
- Rate limits/timeout mot LLM eller marknadsdata
- LLM-svar saknar struktur

## Scope
### In scope (MVP)
- Mobilvänlig webbapp (responsive) som går att öppna via en URL
- Import av Avanza-innehav via fil-uppladdning (exakt format bestäms i “Open questions”)
- Lagra portföljdata lokalt på servern (en användare) + historik av analyser
- Manuell “Kör analys”-knapp
- Schemalagd nattlig körning (t.ex. 01:00 lokal tid)
- Analys-pipeline som sammanställer:
	- portföljdata
	- strategi (global)
	- tes per aktie
	- marknadsdata (kurser + index)
- LLM-baserad analys som resulterar i en strukturerad rapport (JSON) som appen renderar

### Out of scope (första versionen)
- Multi-user, inloggning, delning
- Automatisk live-integration mot Avanza API (utan fil)
- Orderläggning/handel
- Skatteberäkningar
- Realtidsstreaming
- Avancerad nyhets/sentiment pipeline (kan komma senare)

## Requirements
### Produkt
- Appen ska vara mobilvänlig (primärt mobil, sekundärt desktop)
- Jag ska kunna ladda upp mitt innehav från Avanza och se en tydlig portföljöversikt
- Jag ska kunna trigga analys manuellt och se resultatet
- Nattlig analys ska köras automatiskt och spara en ny rapport
- Rapporten ska ge rekommendationer per innehav och på portföljnivå

### Data & modell
- Systemet ska kunna spara:
	- senaste importerade innehav
	- strategi (text)
	- tes per aktie (text)
	- analysresultat med tidsstämpel
- LLM-prompten ska inkludera strategi + teser + portfölj + marknadsdata
- LLM-resultatet ska vara maskinläsbart (t.ex. JSON med strikt schema) och valideras

### Edge cases
- Importfilen innehåller okända/internationella tickers eller saknar kursdata
- Dubbletter i filen
- Innehav med 0 antal
- Saknade teser för vissa aktier (systemet ska hantera det och markera “saknar tes”)
- LLM failure: systemet ska visa “analys misslyckades” och logga orsaken utan att krascha

## Acceptance criteria
- [ ] Jag kan öppna appen i mobilen och se en startsida/dash.
- [ ] Jag kan ladda upp en Avanza-export och appen visar importerade innehav (minst: namn/ticker, antal, eventuell vikt).
- [ ] Jag kan ange/uppdatera en portföljstrategi (fri text) och en tes per aktie.
- [ ] Jag kan klicka “Kör analys” och få en ny rapport som sparas och visas.
- [ ] Rapporten innehåller per aktie: rekommendation (`KÖP`/`SÄLJ`/`BEHÅLL`), motivering (text), risker, och en “confidence” (låg/medel/hög).
- [ ] Nattlig scheduler kör analys automatiskt (kan verifieras via log + tidsstämpel på ny rapport).
- [ ] Om LLM eller marknadsdata är nere visas ett begripligt fel i UI och analysen markeras som misslyckad utan att appen blir obrukbar.

### Acceptance criteria (security/observability)
- [ ] Utan auth får man inte åtkomst till appen/API (minst 401 för API + skydd av startsidan).
- [ ] Med korrekt login (username/password) kan jag använda appen.
- [ ] Vid analys sparas token-usage (minst per analys + ackumulerat), och kan visas i UI eller via endpoint.
- [ ] Om analysen tar längre än timeout så avbryts den och markeras som misslyckad, med begripligt fel i UI.

## Non-functional
- [ ] Security: API-nycklar (LLM/marknadsdata) får inte checkas in; läses från env/secret.
- [ ] Security: servern ska kunna köras med TLS (HTTPS) mellan klient och server (rekommenderat: reverse proxy som Caddy/nginx framför appen).
- [ ] Security: enkel inloggning (username/password) för att komma åt applikationen.
- [ ] Privacy: portföljdata är känslig — datalagring ska vara lokal och skyddad (minst filrättigheter; senare auth).
- [ ] Observability: logga import och analyskörningar (tid, status, fel) + correlation-id per körning.
- [ ] Observability: basal loggning ska finnas utan extra beroenden (använd standard/logg som redan finns i Fastify/Node).
- [ ] Reliability: schemalagd körning ska tåla omstart och inte köra flera parallella analyser.
- [ ] Performance: manuell analys ska ge respons inom rimlig tid; om lång tid ska UI visa progress/laddning.
- [ ] Performance: analys får inte ta mer än 60 sekunder (konfigurerbart) per körning.

## Open questions
- Vilket Avanza-format vill du stödja först (CSV från “Innehav”-sida, PDF, eller något annat)?
- Vill du använda en specifik datakälla för marknadsdata (t.ex. Yahoo Finance, Alpha Vantage, Avanza-kurser, Nordnet, osv), eller börja med mock?
- Vilken LLM-provider tänker du (OpenAI, Azure OpenAI, Anthropic, lokal modell)?
- Ska rekommendationer vara “råd” eller mer “scenarier” (t.ex. ombalansering mot målallokering)?

## Notes (implementation hint)
- Bra första teknisk skärning: separera i
	- `import` (Avanza → normaliserad portfölj)
	- `market-data` (tickers/index → prices)
	- `analysis` (prompt + LLM + schema validation)
	- `ui` (dashboard + rapportvy)
