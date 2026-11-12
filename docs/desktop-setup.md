# Shipyard w Claude Desktop — konfiguracja krok po kroku

Jak pracować z Shipyardem wyłącznie w Claude Desktop (zakładka **Code**), bez
okien terminala, z wieloma procesami naraz i z wznawianiem w nowym wątku.

## 1. Model pracy

- Wszystko dzieje się w Claude Desktop → **Code**. Nowy wątek dodajesz plusem;
  wszystkie wątki widać w pasku bocznym.
- Wątki działają **lokalnie** (Claude Desktop uruchamia Claude Code w tle na
  tym komputerze). Nie używamy sesji w chmurze ani usługi Windows: chmura nie
  widzi dysków sieciowych, NAS-a, After Effects ani RenderPala.
- Logowanie do CLI (`codex login`, `grok login`, `claude auth login`) robisz w
  panelu **Terminal** wewnątrz Claude Desktop — nie w osobnym oknie.

## 2. Autostart Claude Desktop

Claude Desktop (wersja ze Sklepu / MSIX) ma własne zadanie autostartu. Domyślnie
jest wyłączone. Włącz je jednym z dwóch miejsc:

- **Ustawienia Windows → Aplikacje → Autostart → Claude → Wł.**, albo
- **Menedżer zadań → Aplikacje autostartu → Claude → Włącz**.

Skrót w `shell:startup` nie jest potrzebny. Gdyby zadania autostartu zabrakło na
liście, dopiero wtedy dodaj skrót do Claude w `shell:startup`.

## 3. Wtyczka w zakresie użytkownika

Shipyard jest zainstalowany w zakresie **user**, więc działa w każdym wątku, w
każdym folderze i dla każdego repo:

- marketplace `shipyard` → źródło katalogowe `C:\Scripts\shipyard`,
- wtyczka `shipyard@shipyard` → włączona w `~/.claude/settings.json`.

Dostępne wszędzie: `/shipyard:shipping-plans-with-agents`, `/shipyard:resume`,
`/shipyard:doctor` i agenci (Astra, Fable, Luna, Opus, Sonnet, Grok…).

Sprawdzenie (panel Terminal):

```
claude plugin list
```

### Aktualizacja wtyczki po zmianach w repo

Live checkout `C:\Scripts\shipyard` dostaje tylko `git pull` po zatwierdzeniu PR.
Potem odśwież kopię wtyczki i otwórz nowy wątek:

```
git -C C:\Scripts\shipyard pull
claude plugin marketplace update shipyard
claude plugin update shipyard@shipyard
```

Uwaga: aktualizacja zmienia skill dla **wszystkich** procesów, także trwających —
od następnego wznowienia. Aktualizuj świadomie.

### Repo Shipyard: fork i upstream

Shipyard to projekt `esse/shipyard`. Nasze zmiany żyją w forku
`creativeplanetpl/shipyard`:

- `origin` → `creativeplanetpl/shipyard` (tu pushujemy gałęzie i otwieramy PR),
- `upstream` → `esse/shipyard` (tylko pobieranie; push zablokowany).

Dociąganie zmian autora: `git fetch upstream` i PR `upstream/main` → `main` w forku.

## 4. Zmienna `SHIPYARD_HOME`

Skille i skrypty szukają procesów w `SHIPYARD_HOME`. W `~/.claude/settings.json`:

```json
{ "env": { "SHIPYARD_HOME": "C:\\Scripts\\Workflow\\.shipyard" } }
```

Działa w każdym nowym wątku Claude Code. Bez niej `/shipyard:resume` zatrzyma się
i poprosi o ustawienie.

## 5. Układ folderów procesu

```
C:\Scripts\Workflow\.shipyard\
  INDEX.md                 lista procesów: nazwa, repo, gałąź, etap, ostatnia zmiana, stan
  <nazwa>-<rrrrmmdd>\
    SPEC.md                wymagania (źródło prawdy)
    PLAN.md                plan po przeglądach
    STATUS.md              etap, otwarte zadania, co czeka na mnie, ostatni commit/deploy
    DECISIONS.md           decyzje i odpowiedzi
    briefs\                briefy implementerów i poprawek
    reviews\               przeglądy Fable/Astry/Groka/Opusa
    wt\                    worktree: <repo>-<zadanie>, <repo>-int
    scratch\               pliki tymczasowe
  _archive\                zakończone procesy
```

Zasady (pełna wersja: `skills/shipping-plans-with-agents/process-layout.md`):

- **Checkouty live zostają na miejscu** (`C:\Scripts\Workflow\cp-adobe`,
  `C:\Scripts\Node\cp-tool`, `C:\Scripts\Workflow\cp-api`, `C:\Scripts\shipyard`).
  Proces pracuje tylko w swoim `wt\`. Live dostaje tylko `git pull` po
  zatwierdzeniu.
- **Gałęzie:** integracyjna `shipyard/<proces>`, zadaniowe `shipyard/<proces>-<zadanie>`.
  `main` nigdy nie jest zmieniany ani pushowany.
- **STATUS.md** jest aktualizowany przy każdej zmianie etapu i za każdym razem,
  gdy proces czeka na Ciebie. To jedyna pamięć, którą dostaje następny wątek.

### Skrypty (`scripts\` w repo Shipyard)

| Skrypt | Co robi |
|---|---|
| `New-ShipyardProcess.ps1 -Name <slug> -Repo <checkout>[,…] [-Spec <plik>]` | zakłada folder, SPEC/PLAN/STATUS/DECISIONS, wiersz w INDEX.md i worktree `wt\<repo>-int` na `shipyard/<proces>` |
| `Remove-ShipyardWorktree.ps1 -Path <wt> \| -Process <proces> [-Force] [-WhatIf]` | usuwa worktree bezpiecznie przy junctions |
| `Close-ShipyardProcess.ps1 -Process <proces> [-WhatIf]` | usuwa worktree, oznacza `done` w INDEX.md, przenosi do `_archive\` |

Skill `shipping-plans-with-agents` sam uruchamia `New-ShipyardProcess.ps1`, gdy
nowy proces nie ma jeszcze folderu.

**Junctions.** Worktree często mają `node_modules` albo `deps` jako junction do
wspólnego folderu. `Remove-Item -Recurse` (PowerShell 5.1), `rmdir /s` i
niektóre wersje gita wchodzą w junction i kasują **cel**. Dlatego:

- nigdy nie usuwaj rekursywnie folderu, który może zawierać junction;
- `Remove-ShipyardWorktree.ps1` przechodzi drzewo bez wchodzenia w junctions,
  odpina każdy link osobno (sam link, nie cel), sprawdza, że nic nie zostało, i
  dopiero wtedy woła `git worktree remove`. Gdy git odmówi — zatrzymuje się;
- odmawia dla checkoutu głównego, ścieżki spoza `git worktree list` i worktree z
  niezacommitowanymi zmianami (chyba że `-Force`). Gałęzie zostają.

Zawsze najpierw `-WhatIf`.

## 6. Wznawianie: `/shipyard:resume`

- `/shipyard:resume` — lista otwartych procesów z `INDEX.md` oraz starszych
  folderów z `STATUS.md`, które nie mają wiersza w indeksie.
- `/shipyard:resume <proces>` — pełna nazwa albo jednoznaczny początek, np.
  `/shipyard:resume film` → `film-workflow-20261026`. Czyta STATUS, SPEC, PLAN,
  DECISIONS (i HANDOFF.md w starszych procesach), porównuje z faktycznym stanem
  worktree i gałęzi, mówi w kilku linijkach, gdzie proces stoi, i kontynuuje od
  tego etapu.

## 7. Kilka wątków naraz

- **Jeden wątek = jeden proces**, z własną gałęzią i własnymi worktree. Dwa wątki
  na tym samym procesie będą sobie nadpisywać STATUS.md i worktree. Resume
  zapisuje znacznik `ACTIVE` i pyta, jeśli inny wątek dotykał procesu w ciągu
  ostatnich 6 godzin.
- **Limity modeli są wspólne** dla wszystkich wątków:
  - **Claude** (orkiestrator w każdym wątku + Fable, Opus, Sonnet) — jedna pula
    planu Claude,
  - **Codex** (Astra, Luna) — jedna pula konta ChatGPT/Codex,
  - **Grok** (grok-implementer, grok-reviewer) — jedna pula konta Grok.

  Trzy procesy w etapie 3 to trzy razy więcej równoległych wywołań na tych samych
  limitach. Gdy limit się skończy, stoją wszystkie wątki, które go używają.
  Rozsądnie: najwyżej jeden proces w etapie 3 naraz; pozostałe w planowaniu lub
  przeglądzie.

## 8. Logowania

### Które CLI wymaga ponownego logowania

`/shipyard:doctor` zaczyna od tabeli logowań (Claude, Codex, Grok) z komendą do
uruchomienia w panelu Terminal. Nie loguje się sam.

- **Codex** (logowanie przez ChatGPT) odświeża token sam, dopóki jest używany.
  Po dłuższej przerwie albo zmianie hasła może wymagać `codex login`.
- **Grok** — token jest związany z planem. Po zmianie planu: `grok logout`, potem
  `grok login`. Objaw: `grok models` mówi „logged in”, ale brak modelu `grok-4.7`.
- **Claude Code CLI** — `claude auth status` pokazuje datę wygaśnięcia; odnawia
  się samo przy użyciu.

### Wylogowania Claude Desktop — diagnoza

Ustalenia z tego komputera (listopad 2026):

- Aplikacja aktualizowała się bardzo często: w dniach 3–11.11 sześć wersji, w tym
  przejście 4.x → 5.x. Windows wielokrotnie odkładał aktualizację („aplikacja
  działa”) i nakładał ją przy następnym uruchomieniu.
- 11.11 dane aplikacji zostały przeniesione z `%APPDATA%\Claude` do
  `%LOCALAPPDATA%\Claude-Data` (znacznik `.user-data-left`).
- Logowanie Claude Desktop jest trzymane w ciasteczkach w `Claude-Data` i
  szyfrowane kluczem Windows (DPAPI). Wylogowuje m.in. reset danych aplikacji,
  „Clear Cache and Restart” i migracja danych przy dużej aktualizacji.
- Logi aplikacji są puste, więc nie da się wskazać przyczyny każdego wylogowania
  z osobna. Najbardziej prawdopodobne: aktualizacje i migracja danych.

Co robić:

- nie używać „Clear Cache and Restart” ani „Reset App Data”, nie czyścić
  `Claude-Data`;
- włączyć autostart (sekcja 2) — aktualizacje nakładają się wtedy przy starcie,
  nie w trakcie pracy;
- jeśli wylogowania wracają po 11.11 (po migracji), zgłosić przez
  **Help → Send feedback** z datą i godziną.

## 9. Diagnostyka

- `/shipyard:doctor` — logowania, CLI, sandboxy.
- `claude plugin list` — czy wtyczka jest włączona i w jakiej wersji.
- `printenv SHIPYARD_HOME` (w wątku) — czy zmienna jest widoczna.
