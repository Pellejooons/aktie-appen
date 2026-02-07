# Workflow: create-story

## Syfte
Skapa en ny story-mapp med mallar som stödjer BMAD/agent-baserad utveckling.

## Input
- `story-id` (krav: kort, filsystemsvänligt, t.ex. `STORY-001`)
- `title` (valfritt)
- `goal` (valfritt)
- `context` (valfritt)

## Output
Skapar `stories/<story-id>/` med:
- `story.md`
- `tasks.md`
- `notes.md`
- `qa.md`

## Regler
- Skriv inte över befintlig story-mapp utan `--force`.
- Storyn ska ha tydliga acceptanskriterier.
- Tasks ska ha minst: design, implementation, tester, dokumentation.
