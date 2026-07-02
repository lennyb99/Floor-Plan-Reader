#!/usr/bin/env python3
"""
Farbanalyse für PNG-Bilder
===========================

Analysiert eine PNG-Datei und gibt aus, welche Farbwerte enthalten sind
und wie oft jede Farbe vorkommt.

Voraussetzung:
    pip install Pillow

Verwendung:
    python png_farbanalyse.py bild.png
    python png_farbanalyse.py bild.png --top 20
    python png_farbanalyse.py bild.png --sortierung farbe
    python png_farbanalyse.py bild.png --csv ergebnis.csv
"""

import argparse
import csv
import sys
from collections import Counter
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print(
        "Fehler: Das Paket 'Pillow' wird benötigt, ist aber nicht installiert.\n"
        "Installation mit:  pip install Pillow",
        file=sys.stderr,
    )
    sys.exit(1)


def bild_laden_und_zaehlen(pfad: Path):
    """Öffnet die Bilddatei und zählt, wie oft jede Farbe vorkommt."""
    with Image.open(pfad) as img:
        modus = img.mode

        # Palette-Bilder (Modus "P") und exotischere Modi in ein
        # einheitliches Format bringen, damit die Farbwerte direkt
        # als RGB(A)- bzw. Graustufen-Tupel vorliegen.
        if modus == "P":
            img = img.convert("RGBA") if "transparency" in img.info else img.convert("RGB")
        elif modus not in ("RGB", "RGBA", "L", "LA", "1"):
            img = img.convert("RGBA")

        img.load()
        groesse = img.size
        max_moegliche_farben = groesse[0] * groesse[1]
        rohdaten = img.getcolors(maxcolors=max_moegliche_farben)
        if rohdaten is None:
            # type: ignore is needed because type checkers don't recognize Pillow's ImagingCore as Iterable
            zaehler = Counter(img.getdata())  # type: ignore
        else:
            zaehler = Counter({farbe: anzahl for anzahl, farbe in rohdaten})
        end_modus = img.mode

    return zaehler, end_modus, groesse


def zu_hex(farbe, modus: str) -> str:
    """Wandelt einen Farbwert in einen Hex-Code um."""
    if modus in ("L", "1"):
        wert = farbe if isinstance(farbe, int) else farbe[0]
        return f"#{wert:02X}{wert:02X}{wert:02X}"
    if modus == "LA":
        grau, alpha = farbe
        return f"#{grau:02X}{grau:02X}{grau:02X}{alpha:02X}"
    if modus == "RGB":
        r, g, b = farbe
        return f"#{r:02X}{g:02X}{b:02X}"
    if modus == "RGBA":
        r, g, b, a = farbe
        return f"#{r:02X}{g:02X}{b:02X}{a:02X}"
    return "-"


def farbe_lesbar(farbe, modus: str) -> str:
    """Formatiert einen Farbwert als lesbaren Text."""
    if modus in ("L", "1"):
        wert = farbe if isinstance(farbe, int) else farbe[0]
        return f"Grau({wert:3d})"
    if modus == "LA":
        grau, alpha = farbe
        return f"Grau({grau:3d}), Alpha={alpha:3d}"
    if modus == "RGB":
        r, g, b = farbe
        return f"RGB({r:3d}, {g:3d}, {b:3d})"
    if modus == "RGBA":
        r, g, b, a = farbe
        return f"RGBA({r:3d}, {g:3d}, {b:3d}, {a:3d})"
    return str(farbe)


def ansi_farbblock(farbe, modus: str) -> str:
    """Erzeugt einen kleinen farbigen Block (ANSI-Escape-Code) für die Terminal-Vorschau."""
    if modus in ("RGB", "RGBA"):
        r, g, b = farbe[0], farbe[1], farbe[2]
    elif modus in ("L", "LA", "1"):
        wert = farbe if isinstance(farbe, int) else farbe[0]
        r = g = b = wert
    else:
        return "  "
    return f"\033[48;2;{r};{g};{b}m  \033[0m"


def main():
    parser = argparse.ArgumentParser(
        description="Analysiert eine PNG-Datei und listet alle enthaltenen Farbwerte mit Häufigkeit auf.",
        epilog=(
            "Beispiele:\n"
            "  %(prog)s bild.png\n"
            "  %(prog)s bild.png --top 20\n"
            "  %(prog)s bild.png --csv ergebnis.csv\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("bild", type=Path, nargs="?", default=None, help="Pfad zur PNG-Datei (optional, nimmt sonst erstes PNG im Ordner)")
    parser.add_argument(
        "-n", "--top", type=int, default=None,
        help="Nur die N häufigsten Farben anzeigen (Standard: alle anzeigen)",
    )
    parser.add_argument(
        "-s", "--sortierung", choices=["haeufigkeit", "farbe"], default="haeufigkeit",
        help="Sortierreihenfolge der Ausgabe (Standard: haeufigkeit)",
    )
    parser.add_argument(
        "-c", "--csv", type=Path, default=None,
        help="Vollständiges Ergebnis zusätzlich als CSV-Datei speichern",
    )
    parser.add_argument(
        "--keine-farbvorschau", action="store_true",
        help="Farbige Vorschaublöcke in der Terminalausgabe deaktivieren",
    )
    args = parser.parse_args()

    if args.bild is None:
        png_dateien = list(Path('.').glob("*.png"))
        if not png_dateien:
            print("Fehler: Kein Bild angegeben und keine .png Datei im aktuellen Ordner gefunden.", file=sys.stderr)
            sys.exit(1)
        args.bild = png_dateien[0]
        print(f"Kein Bild angegeben. Verwende automatisch: {args.bild}\n")

    if not args.bild.exists():
        print(f"Fehler: Die Datei '{args.bild}' wurde nicht gefunden.", file=sys.stderr)
        sys.exit(1)

    try:
        zaehler, modus, groesse = bild_laden_und_zaehlen(args.bild)
    except Exception as fehler:
        print(f"Fehler beim Einlesen des Bildes: {fehler}", file=sys.stderr)
        sys.exit(1)

    gesamt_pixel = sum(zaehler.values())
    anzahl_farben = len(zaehler)

    print(f"Datei:                    {args.bild}")
    print(f"Bildgröße:                {groesse[0]} x {groesse[1]} Pixel ({gesamt_pixel} Pixel gesamt)")
    print(f"Farbmodus:                {modus}")
    print(f"Unterschiedliche Farben:  {anzahl_farben}")
    print("-" * 66)

    if args.sortierung == "haeufigkeit":
        eintraege = zaehler.most_common(args.top)
    else:
        eintraege = sorted(zaehler.items(), key=lambda paar: paar[0])
        if args.top:
            eintraege = eintraege[: args.top]

    vorschau_aktiv = sys.stdout.isatty() and not args.keine_farbvorschau
    kopf_praefix = "   " if vorschau_aktiv else ""
    print(f"{kopf_praefix}{'Farbe':<28} {'Hex':<11} {'Anzahl':>10}   Anteil")

    for farbe, anzahl in eintraege:
        anteil = anzahl / gesamt_pixel * 100
        praefix = (ansi_farbblock(farbe, modus) + " ") if vorschau_aktiv else ""
        zeile = f"{farbe_lesbar(farbe, modus):<28} {zu_hex(farbe, modus):<11} {anzahl:>10}   {anteil:5.2f}%"
        print(praefix + zeile)

    if args.top and args.top < anzahl_farben:
        print(f"\n… und {anzahl_farben - args.top} weitere Farbe(n) nicht angezeigt (siehe --top).")

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as datei:
            writer = csv.writer(datei)
            writer.writerow(["Farbe", "Hex", "Anzahl", "Anteil_Prozent"])
            for farbe, anzahl in zaehler.most_common():
                anteil = anzahl / gesamt_pixel * 100
                writer.writerow([farbe_lesbar(farbe, modus), zu_hex(farbe, modus), anzahl, f"{anteil:.4f}"])
        print(f"\nVollständige Ergebnisliste gespeichert unter: {args.csv}")


if __name__ == "__main__":
    main()