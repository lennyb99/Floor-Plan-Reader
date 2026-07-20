# Floor Plan Reader – Prototype

Der Prototyp verarbeitet eine Grundrissskizze in einem durchgängigen Ablauf:

1. automatische Papier-/Schattenbereinigung, inhaltsbasierter Zuschnitt auf **512 × 512 px** und Gamma-Korrektur,
2. U-Net-Wandsegmentierung mit Hysterese-Schwelle,
3. konservatives Ensemble aus Foto-/Ink-YOLO und Handdrawn-YOLO für Türen, Fenster, Sanitär und Einrichtung,
4. konservativer Hybrid-Fallback aus U-Net und strukturellen Langlinien, richtungsbewusste Reparatur kleiner Wandlücken sowie Zusammenführung doppelter Wandachsen,
5. 2D-Korrektur und interaktive 3D-Ansicht.

Vor der eigentlichen Inferenz zeigt der vierstufige Produktablauf eine exakte
Vorschau des aufbereiteten 512×512-Eingabebilds. Gamma und Smart Crop lassen
sich dort kontrollieren, ohne bereits eine rechenintensive Analyse zu starten.

Die 3D-Ansicht kann das bereinigte Modell direkt als GLB exportieren. Diagnose-
Links sind in der normalen Oberfläche ausgeblendet und werden bei Bedarf über
`?debug=1` eingeblendet.

## Schnellstart

Voraussetzung ist Python 3.12.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r product/requirements.txt
python -m product.backend.server
```

Danach [http://127.0.0.1:8000](http://127.0.0.1:8000) öffnen, eine PNG-/JPG-/TIFF-Datei auswählen, die Bildaufbereitung prüfen und **Analyze floor plan** klicken.

In **Revise** wird ein Wandsegment durch Anklicken ausgewählt. Es kann direkt
gezogen oder mit den Pfeiltasten verschoben werden; `Shift` + Pfeiltaste bewegt
es in 10-px-Schritten. Zugeordnete Türen und Fenster bleiben am Segment. In der
3D-Ansicht stehen getrennte Schalter für semitransparente Wände, Objekte und den
Boden zur Verfügung.

In Google Colab darf die Installation den vorinstallierten PyTorch-/CUDA-Stack
nicht ersetzen. Nach einem Colab-Reset wird deshalb die eigene, minimale
Colab-Liste verwendet:

```bash
python -m pip install -r product/requirements-colab.txt
```

Auf Apple-Silicon wird standardmäßig MPS verwendet, sofern verfügbar. Für einen festen Ausführungsmodus kann `FPR_DEVICE=cpu`, `FPR_DEVICE=mps` oder `FPR_DEVICE=cuda` gesetzt werden.

## Empfohlene Gewichte

- YOLO primär: `yolo_real1.pt` – erkennt Betten, Herde und Treppen auf fotografierten Tintenskizzen am zuverlässigsten.
- YOLO ergänzend: `yolo_cc_Handdrawn1.pt` – liefert nur ausreichend sichere, noch fehlende Sanitär-/Öffnungsobjekte. Eine geometrische Hochpräzisionsregel ergänzt übersehene Treppen mit mindestens fünf regelmäßigen Stufenlinien.
- U-Net: `unet_real_finetuned_v1.pt` – auf den leakage-freien Splits aus `real_training` und `real_training_aug` feinjustiert. Die Schwellen `0.50/0.42` wurden ausschließlich auf dem Validation-Split kalibriert.

Der Produktionspfad `/analyze` verwendet dieses feste, getestete Preset, damit
keine inkompatible Kombination wie Photo-YOLO + Clean-Plan-U-Net versehentlich
aktiviert wird. Alle vorhandenen Einzelgewichte bleiben auf `/detect.html` und
`/unet_debug.html` vergleichbar. Gewichtsabhängige U-Net-Schwellen und
invertierte Legacy-Ausgaben sind in `product/backend/model_config.py` hinterlegt.

## Qualitätskontrolle

```bash
python -m unittest discover -s tests -v
```

Debug-Seiten:

- `/unet_debug.html` zeigt Maske, Skelett, Vektoren und reparierte Topologie.
- `/detect.html` visualisiert die YOLO-Erkennung.
- `/docs` zeigt die automatisch erzeugte FastAPI-Dokumentation.

## Fine-Tuning mit den Drive-Datensätzen

Für die reale Eingabedomäne sind `real_training` (51 Bilder) und
`real_training_aug` (357 Bilder) die wichtigsten Ordner. Die augmentierten
Varianten enthalten genau die Rotation, Perspektive, Beleuchtung und den
Kontrastverlust, die bei Handyfotos auftreten. `real_sketches` bleibt als
unabhängiger visueller Testbestand reserviert; die enthaltenen Roh-/Clean-Paare
sind nicht automatisch Wandmasken.

`real_test` ist der feste, vollständig annotierte Holdout: 20 Bilder aus fünf
Grundplänen, jeweils mit Wandmaske und YOLO-Label für neun Klassen. Er wird vom
Trainingsskript ausdrücklich ausgeschlossen und darf weder trainiert noch
augmentiert oder zur Schwellenkalibrierung verwendet werden.

Der Trainingslauf versteht sowohl diese flache Ordnerstruktur als auch die
älteren `train`/`val`-Splits. Varianten derselben Originalskizze werden immer
gemeinsam einem Split zugeordnet. Dadurch geraten Augmentierungen eines
Validierungsbildes nicht in das Training. Die älteren CubiCasa-Domänen können
optional über `--include-synthetic` zugeschaltet werden.

Beispiel für Google Colab:

```python
from google.colab import drive
drive.mount('/content/drive')
```

```bash
python training/train_drive_models.py \
  --drive-root /content/drive/MyDrive \
  --model all \
  --device 0 \
  --output /content/drive/MyDrive/FloorPlanReader_runs/real_finetune_v1
```

Ohne GPU kann zunächst nur die Datensatzprüfung ausgeführt werden:

```bash
python training/train_drive_models.py --drive-root /content/drive/MyDrive --model audit
```

Die besten Gewichte und Validierungsmetriken landen im angegebenen
Ausgabeordner. Bestehende Produktgewichte werden dabei nicht überschrieben.
Das U-Net-Checkpointing berücksichtigt neben IoU auch Randtreue und
Wand-Topologie; Early Stopping verhindert unnötiges Übertrainieren.

Vor dem finalen Holdout-Test kann das neue Checkpoint fair gegen das
Ausgangsgewicht auf demselben gespeicherten Validation-Split verglichen werden:

```bash
python training/compare_unet_validation.py \
  --drive-root /content/drive/MyDrive \
  --manifest /content/drive/MyDrive/FloorPlanReader_runs/real_finetune_v1/split_manifest.json \
  --weights product/backend/weights/unet_final_onlymax.pt \
    /content/drive/MyDrive/FloorPlanReader_runs/real_finetune_v1/unet_floorplan_512.pt \
  --device 0
```

Für ein überlegenes Checkpoint werden anschließend ausschließlich auf diesem
Validation-Split die Hysterese-Schwellen kalibriert. Die Modellinferenz erfolgt
dabei nur einmal; `real_test` bleibt unberührt:

```bash
python training/calibrate_unet_validation.py \
  --drive-root /content/drive/MyDrive \
  --manifest /content/drive/MyDrive/FloorPlanReader_runs/real_finetune_v1/split_manifest.json \
  --weights /content/drive/MyDrive/FloorPlanReader_runs/real_finetune_v1/unet_floorplan_512.pt \
  --device 0
```

Der freigegebene Lauf `real_finetune_v1` verbessert das bisherige
`unet_final_onlymax.pt` auf dem unveränderten `real_test`-Holdout von Dice
`0.8098` / IoU `0.6804` auf Dice `0.8281` / IoU `0.7066`. Boundary-F1 beträgt
`0.9699`, der Topology-Score `0.6166`. Das getestete Produktionsgewicht hat die
SHA-256-Prüfsumme
`2ced00dd57bf0be877c85fd5d3dad8b5e8c20be47ec38d542fe9494191ff437c`.
Der Endpoint-Score (`0.2607`) bleibt die wichtigste bekannte Schwäche; weitere
Verbesserungen sollen daher das Topologie-Postprocessing adressieren, ohne
`real_test` zur Optimierung zu verwenden.

Nach dem Training werden freigegebene Gewichte genau einmal auf `real_test`
verglichen:

```bash
python training/evaluate_real_test.py \
  --test-root /content/drive/MyDrive/real_test \
  --model all \
  --device cuda
```

Der Bericht `training/runs/real_test/benchmark.json` enthält U-Net Dice/IoU
inklusive schlechtestem Bild und gruppierten Grundplanwerten. Zusätzlich werden
Boundary-F1, Zusammenhang, Fragmentierung, Skelett-Endpunkte/-Kreuzungen und
Wanddickenfehler ausgewiesen. Für YOLO enthält er mAP50, mAP50–95, Precision
und Recall für beide Produktgewichte.

## API

`POST /preprocess` erzeugt die schnelle Vorschau für die Bildaufbereitung und
akzeptiert `file`, `gamma` und `auto_crop`. Die Antwort enthält das vorbereitete
Bild als PNG/Base64 sowie die reproduzierbaren Preprocessing-Metadaten.

`POST /analyze` akzeptiert Multipart-Formdaten:

- `file`: Bilddatei (max. 20 MB)
- `gamma`: `0.5` bis `2.5`, Standard `1.25`
- `auto_crop`: Standard `true`
- `detection_confidence`: Standard `0.30`

Die zurückgegebenen Koordinaten beziehen sich immer auf das vorverarbeitete 512×512-Bild. `metadata.preprocessing` dokumentiert den Zuschnitt und mit `cleanup_applied` auch die automatische Dokumentbereinigung reproduzierbar.

Der Langlinien-Fallback übernimmt Rohbildachsen nur, wenn sie eine bereits vom
U-Net gestützte Wand verlängern oder zwei bekannte senkrechte Wandachsen
verbinden. Isolierte Möbelrechtecke werden dadurch nicht als Wände promoted.
