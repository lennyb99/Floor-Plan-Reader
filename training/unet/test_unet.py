import os
import sys

# Add project root to sys.path so absolute imports work at runtime
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import cv2
import torch
import glob
import subprocess
import numpy as np
from product.segmentation.model_training.model_processing import load_segmentation_model, predict_mask

def main():
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    MODELS_DIR = os.path.join(BASE_DIR, "models")
    INPUT_DIR = os.path.join(BASE_DIR, "test_data", "input")
    OUTPUT_DIR = os.path.join(BASE_DIR, "test_data", "output")
    
    # Create directories if they don't exist
    os.makedirs(INPUT_DIR, exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # 1. Find model
    model_files = glob.glob(os.path.join(MODELS_DIR, "*.pth"))
    if not model_files:
        print("[!] Kein Modell im Ordner 'models/' gefunden.")
        print(f"Bitte stelle sicher, dass du zuerst trainierst und das Modell hier liegt: {MODELS_DIR}")
        return
    model_path = model_files[0]
    print(f"[+] Lade Modell: {os.path.basename(model_path)}")
    
    # 2. Find input image
    image_files = [f for f in os.listdir(INPUT_DIR) if f.lower().endswith(('.png', '.jpg', '.jpeg'))]
    if not image_files:
        print("[!] Kein Bild im Ordner 'test_data/input/' gefunden.")
        print(f"Bitte lege genau ein Bild hier ab: {INPUT_DIR}")
        return
    input_image_path = os.path.join(INPUT_DIR, image_files[0])
    print(f"[+] Lade Eingabebild: {image_files[0]}")
    
    # 3. Load model and weights
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[+] Nutze Gerät: {device}")
    model = load_segmentation_model(model_path, device)
    
    # 4 & 5. Process image and predict
    print("[+] Wende Modell an...")
    visible_mask, prob_image = predict_mask(model, input_image_path, device, return_probs=True)
    
    # NEU: Auch die rohen Wahrscheinlichkeiten als Wärmebild/Graustufen speichern
    # (Dies geschieht nun direkt über predict_mask, welches die Bilder formatiert zurückgibt)
    
    # 7. Save output
    output_filename = f"result_{image_files[0]}"
    output_path = os.path.join(OUTPUT_DIR, output_filename)
    cv2.imwrite(output_path, visible_mask)
    
    prob_output_path = os.path.join(OUTPUT_DIR, f"probs_{image_files[0]}")
    cv2.imwrite(prob_output_path, prob_image)
    
    print(f"[+] Binäres Ergebnis gespeichert unter: {output_path}")
    print(f"[+] Wahrscheinlichkeits-Bild (Graustufen) gespeichert unter: {prob_output_path}")
    print(f"[+] Pixel-Werte im Binärbild: {np.unique(visible_mask)} (0=Hintergrund, 255=Vorhersage)")
    
    # 8. Analyze with png_verifier
    verifier_path = os.path.abspath(os.path.join(BASE_DIR, "..", "debug", "verify_png", "png_verifier.py"))
    if os.path.exists(verifier_path):
        print(f"\n[+] Analysiere Ausgabebild mit png_verifier.py...")
        subprocess.run([sys.executable, verifier_path, output_path])
    else:
        print(f"\n[!] png_verifier.py nicht gefunden unter: {verifier_path}")

if __name__ == "__main__":
    main()
