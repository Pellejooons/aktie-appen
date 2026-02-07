# STORY-001 — QA

## Test plan
- [ ] Unit: CSV-parser
	- [ ] Happy path: läser minst ticker/namn + antal
	- [ ] Missing columns: ger begripligt fel
	- [ ] Dubbletter: slås ihop eller flaggas (enligt beslut)
- [ ] Unit: LLM response validation
	- [ ] Validerar att output matchar schema
	- [ ] Felaktig JSON → graceful failure och tydligt fel i API
- [ ] Integration/smoke
	- [ ] import → portfolio → analyze (mock OpenAI) → latest report

## Quality gates
- [ ] Build
- [ ] Lint/format
- [ ] Typecheck (om relevant)
- [ ] Tests

## Verification notes
- Scheduler:
	- [ ] Verifiera att nattlig körning skapar en ny `AnalysisRun`
	- [ ] Verifiera att parallella körningar inte sker
- UI:
	- [ ] Mobilvy: import, strategi/teser, rapport
	- [ ] Empty state: ingen import → vägledning i UI
