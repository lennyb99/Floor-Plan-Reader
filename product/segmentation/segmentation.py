import os
import argparse
import json
import cv2
import glob
import numpy as np
from typing import Union, Optional, Dict, Any

# Ensure imports work regardless of where the script is run from
import sys
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

import torch
from product.segmentation.model_training.model_processing import load_segmentation_model, predict_mask
from product.segmentation.geometry_pipeline.pipeline_runner import process_image as geometry_process_image

def run_full_segmentation_pipeline(
    image_source: Union[str, np.ndarray], 
    model: Optional[torch.nn.Module] = None,
    model_path: Optional[str] = None,
    device: Optional[torch.device] = None
) -> Dict[str, Any]:
    """
    Führt die gesamte Segmentierungspipeline im Arbeitsspeicher aus.
    1. Bild -> KI-Modell -> Binäre Maske
    2. Binäre Maske -> Geometrie-Pipeline -> JSON Dictionary
    
    Args:
        image_source: Dateipfad (str) oder Numpy-Array des Eingabebilds (Grundriss).
        model: Ein bereits geladenes PyTorch-Modell (empfohlen für Performance).
        model_path: Wenn kein model übergeben wird, kann stattdessen der Pfad zum Modell übergeben werden.
        device: 'cpu' oder 'cuda' (optional).
        
    Returns:
        Ein Dictionary, das den extrahierten Grundriss (Wände) enthält.
    """
    if model is None:
        if model_path is None:
            raise ValueError("Es muss entweder ein geladenes Modell oder ein model_path übergeben werden.")
        model = load_segmentation_model(model_path, device=device)
        
    # 1. KI-Vorhersage (Erzeugt Maske aus Eingabebild)
    mask = predict_mask(model, image_source, device=device, return_probs=False)
    
    # Type narrowing for static analysis
    if isinstance(mask, tuple):
        mask = mask[0]
    
    # 2. Geometrie-Vektorisierung (Erzeugt JSON aus Maske)
    # Da mask bereits ein Numpy-Array (Graustufen, 0/255) ist, können wir es direkt übergeben
    json_dict = geometry_process_image(mask, debug=False, output_dir=None)
    
    return json_dict


def _cli_main():
    """
    Kommandozeilen-Einstiegspunkt für Debugging/lokale Ausführung.
    Liest aus 'data/', wendet die Pipeline an und schreibt die JSON in 'data/'.
    """
    parser = argparse.ArgumentParser(description="Floor Plan Reader - Full Segmentation Pipeline")
    parser.add_argument(
        "--image", 
        type=str, 
        help="Dateiname des Bildes im 'data/'-Ordner (Standard: sucht nach dem ersten Bild)."
    )
    parser.add_argument(
        "--model", 
        type=str, 
        help="Pfad zum trainierten Modell (.pth) (Standard: sucht in model_training/models/)."
    )
    args = parser.parse_args()

    base_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(base_dir, "data")
    
    # Sicherstellen, dass das Data-Verzeichnis existiert
    os.makedirs(data_dir, exist_ok=True)
    
    # 1. Modell finden
    model_path = args.model
    if not model_path:
        default_models_dir = os.path.join(base_dir, "model_training", "models")
        model_files = glob.glob(os.path.join(default_models_dir, "*.pth"))
        if not model_files:
            print(f"[!] Kein Modell gefunden in {default_models_dir}.")
            print("Bitte Modellpfad via --model angeben.")
            return
        model_path = model_files[0]
        
    print(f"[+] Verwende Modell: {os.path.basename(model_path)}")
    
    # 2. Eingabebild finden
    image_name = args.image
    if not image_name:
        image_files = [f for f in os.listdir(data_dir) if f.lower().endswith(('.png', '.jpg', '.jpeg'))]
        if not image_files:
            print(f"[!] Kein Bild im Ordner '{data_dir}' gefunden.")
            print("Bitte lege ein Bild dorthin oder nutze --image.")
            return
        image_name = image_files[0]
        
    input_image_path = os.path.join(data_dir, image_name)
    print(f"[+] Lade Eingabebild: {input_image_path}")
    
    # Pipeline ausführen
    print("[+] Starte Segmentierungs-Pipeline (Modell + Geometrie)...")
    try:
        result_json = run_full_segmentation_pipeline(
            image_source=input_image_path,
            model_path=model_path
        )
    except Exception as e:
        print(f"[!] Fehler während der Pipeline-Ausführung: {e}")
        import traceback
        traceback.print_exc()
        return

    # JSON speichern
    output_filename = os.path.splitext(image_name)[0] + "_result.json"
    output_path = os.path.join(data_dir, output_filename)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result_json, f, indent=4)
        
    print(f"\n[+] Pipeline erfolgreich abgeschlossen!")
    print(f"[+] Ergebnisse gespeichert in: {output_path}")

if __name__ == "__main__":
    _cli_main()
