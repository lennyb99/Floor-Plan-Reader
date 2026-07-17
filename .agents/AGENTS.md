# Frontend Architecture Rules

Dieser Workspace beinhaltet ein modulares Vanilla JS / HTML / CSS Frontend (`/product/backend/frontend/`).
Wenn du Änderungen am Frontend vornimmst, MUSST du dich zwingend an folgende architektonische Regeln halten:

## 1. Strikte Trennung von HTML, CSS und JS
- **Kein Inline-JS / CSS**: HTML-Dateien (wie `revise.html`, `view3d.html`, `analyze.html`) dürfen nur das reine Layout und die UI-Struktur definieren.
- **CSS**: Jegliches Styling gehört in die entsprechenden Dateien im Ordner `css/`.
- **JS-Logik**: Die gesamte Anwendungslogik ist in thematisch getrennte Dateien im Ordner `js/` ausgelagert (z.B. `js/revise/`, `js/view3d/`, `js/shared/`).

## 2. Kein Build-System (Vanilla Setup)
- Das Projekt verwendet absichtlich **kein** kompliziertes Build-System (kein Webpack, kein Vite, etc.).
- Füge keine komplexen Bundler oder Node-Abhängigkeiten für das Frontend hinzu, es sei denn, der User fordert dies explizit.

## 3. Zustandsverwaltung (State Management)
- Der State (wie z.B. der aktuell geladene Grundriss) wird App-weit über den `localStorage` (z.B. `floorplan`) synchronisiert.
- Das ermöglicht einen fließenden Übergang der Daten zwischen verschiedenen Tabs (`analyze.html` -> `revise.html` -> `view3d.html`).

## 4. Modulare Scripts
- Achte beim Hinzufügen neuer Skripte strikt auf den Gültigkeitsbereich von Variablen (Scoping) und Lade-Reihenfolgen, da die Skripte stark voneinander abhängen.
- Überschreibe niemals globale Browser-Objekte (wie `window.history`), um Naming-Collisions zu vermeiden.

**Direktive:** Halte den Code so simpel, modular und übersichtlich wie möglich. "Aufteilen, was geht, um möglichst hohe Modularität und Übersicht herzustellen."
