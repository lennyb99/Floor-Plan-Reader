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
from product.segmentation.model_training.model import create_unet_model

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
    model = create_unet_model()
    # weights_only=True is safer and recommended for newer PyTorch versions
    model.load_state_dict(torch.load(model_path, map_location=device, weights_only=True))
    model.to(device)
    model.eval()
    
    # 4. Process image
    img = cv2.imread(input_image_path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        print(f"[!] Konnte Bild nicht laden: {input_image_path}")
        return
        
    original_size = img.shape
    img_resized = cv2.resize(img, (512, 512))
    img_tensor = torch.from_numpy(img_resized).unsqueeze(0).unsqueeze(0).float() / 255.0
    img_tensor = img_tensor.to(device)
    
    # 5. Predict
    print("[+] Wende Modell an...")
    with torch.no_grad():
        output = model(img_tensor)
        probs = torch.sigmoid(output)
        
        # --- NEU: Rohe Wahrscheinlichkeiten analysieren ---
        probs_np = probs.cpu().squeeze().numpy()
        print(f"\n--- Probabilities Analyse ---")
        print(f"Minimale Wahrscheinlichkeit: {probs_np.min():.6f}")
        print(f"Maximale Wahrscheinlichkeit: {probs_np.max():.6f}")
        print(f"Durchschnittliche Wahrscheinlichkeit: {probs_np.mean():.6f}")
        print(f"---------------------------\n")
        
        binary_mask = (probs > 0.5).float().cpu().squeeze().numpy()
        
    # 6. Werte skalieren (damit man nicht nur ein rein schwarzes Bild sieht)
    visible_mask = (binary_mask * 255).astype(np.uint8)
    visible_mask = cv2.resize(visible_mask, (original_size[1], original_size[0]), interpolation=cv2.INTER_NEAREST)
    
    # NEU: Auch die rohen Wahrscheinlichkeiten als Wärmebild/Graustufen speichern
    prob_image = (probs_np * 255).astype(np.uint8)
    prob_image = cv2.resize(prob_image, (original_size[1], original_size[0]), interpolation=cv2.INTER_LINEAR)
    
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
