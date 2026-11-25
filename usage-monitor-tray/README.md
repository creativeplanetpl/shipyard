# AI Monitor — ikona przy zegarze Windows

Pokazuje limity Claude, Codex i Grok (okna 5 godzin i 7 dni, procent zużycia, czas
resetu) w małym panelu otwieranym z ikony obok zegara. Nie potrzebuje Chrome.

- **Codex i Grok** bierze z serwisu Shipyard (`usage-monitor`, `127.0.0.1:43821`).
- **Claude** czyta sama: logujesz się do `claude.ai` jeden raz w oknie aplikacji.
  Odczyt publikuje do serwisu przez `POST /record`, więc Shipyard widzi go w `/pace`.
- Poza aplikację wychodzą tylko procenty, czasy resetu i etykiety. Sesja logowania
  leży wyłącznie w `%LOCALAPPDATA%\cp-AImonitor\tray-data`.

## Instalacja (per użytkownik, bez administratora)

Wymagania: Windows, Node.js 18 lub nowszy, internet (pobiera Electron, ok. 130 MB).

1. Serwis w tle, jeśli jeszcze nie działa:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\Install-UsageMonitor.ps1
   ```

2. Aplikacja (buduje ją na miejscu, kopiuje do `%LOCALAPPDATA%\cp-AImonitor\tray`,
   dodaje do autostartu i uruchamia):

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\usage-monitor-tray\Install-Tray.ps1 -Build
   ```

## Co trzeba zrobić ręcznie

- **Zalogować się do Claude**: kliknąć ikonę przy zegarze, na karcie Claude wybrać
  „Sign in” i zalogować się na własne konto. Jeśli przycisk Google zostanie
  odrzucony w oknie aplikacji, użyć logowania kodem z e-maila.
- **Zalogować Codex CLI i Grok CLI** na własne konta — z nich serwis bierze liczby.
- **Przypiąć ikonę**: Windows chowa nowe ikony pod strzałką „^” obok zegara;
  przeciągnąć ją na pasek.

## Odinstalowanie

```powershell
powershell -ExecutionPolicy Bypass -File .\usage-monitor-tray\Uninstall-Tray.ps1
```

Usuwa program, wpis autostartu i zapisane logowanie do Claude. Serwis zostaje.

## Dla programisty

`npm ci --ignore-scripts`, `npm test` (Vitest), `npm run package`. Panel to
TypeScript + React + Vite z komponentami Mantine, powłoka Electron. Przy wyłączonej
aplikacji `"AI Monitor.exe" --status` wypisuje jeden odczyt jako JSON, a `--probe`
pokazuje, co `claude.ai` odpowiada osadzonej przeglądarce.
