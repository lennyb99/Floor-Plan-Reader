import os
import cv2
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
import segmentation_models_pytorch as smp
from tqdm.auto import tqdm
import matplotlib.pyplot as plt

import sys
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from product.segmentation.model import create_unet_model
from training.unet.train_unet import LocalFloorplanDataset

def finetune_unet(model, dataloader, device, num_epochs=5, learning_rate=0.0001):
    model = model.to(device)
    
    # WICHTIG: Beim Finetuning kann man optional den Encoder einfrieren, 
    # damit das Basiswissen von CubiCasa sicher nicht zerstört wird.
    # Da Handskizzen aber teilweise sehr anders aussehen, lassen wir hier das gesamte Netzwerk 
    # mitlernen, jedoch mit einer viel geringeren Lernrate (z.B. 1e-4 oder 1e-5).
    optimizer = torch.optim.Adam(model.parameters(), lr=learning_rate)
    
    bce_loss_fn = smp.losses.SoftBCEWithLogitsLoss()
    dice_loss_fn = smp.losses.DiceLoss(mode='binary')

    epoch_losses = []
    
    print(f"\n[+] Starte Finetuning auf Gerät: {device}")
    print(f"[+] Bilder im Datensatz: {len(dataloader.dataset)} | Epochen geplant: {num_epochs}\n")

    for epoch in range(num_epochs):
        model.train()
        running_loss = 0.0
        
        pbar = tqdm(dataloader, desc=f"Epoche {epoch+1}/{num_epochs}", leave=True)
        for sketches, masks in pbar:
            sketches = sketches.to(device, non_blocking=True)
            masks = masks.to(device, non_blocking=True)

            predictions = model(sketches)
            loss = bce_loss_fn(predictions, masks) + dice_loss_fn(predictions, masks)

            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            running_loss += loss.item()
            pbar.set_postfix({"loss_this_batch": f"{loss.item():.4f}"})

        avg_loss = running_loss / len(dataloader)
        epoch_losses.append(avg_loss)
        print(f"-> Epoche {epoch+1} beendet. Durchschnittlicher Loss: {avg_loss:.4f}\n")

    plt.figure(figsize=(10, 5))
    plt.plot(range(1, num_epochs + 1), epoch_losses, marker='o', linestyle='-', color='#ff7f0e', label='Finetuning Loss (BCE + Dice)')
    plt.title('Finetuning-Verlust (Loss Curve)')
    plt.xlabel('Epoche')
    plt.ylabel('Verlustwert')
    plt.grid(True, linestyle='--', alpha=0.6)
    plt.legend()
    
    plot_path = "loss_history_finetune_plot.png"
    plt.savefig(plot_path, dpi=150, bbox_inches='tight')
    plt.close()
    print(f"[OK] Finetuning-Verlustkurve wurde als '{plot_path}' gespeichert.")

    return model, epoch_losses

if __name__ == "__main__":
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    MODELS_DIR = os.path.join(BASE_DIR, "models")
    FINETUNE_SKETCHES = os.path.join(BASE_DIR, "finetune_training_data", "train")
    FINETUNE_MASKS = os.path.join(BASE_DIR, "finetune_training_data", "masks")
    
    print("="*60)
    print(" Grundriss-KI: U-Net Fine-Tuning (Transfer Learning)")
    print("="*60)
    
    # 1. Ordnerstrukturen sicherstellen
    os.makedirs(FINETUNE_SKETCHES, exist_ok=True)
    os.makedirs(FINETUNE_MASKS, exist_ok=True)
    
    if not os.path.exists(MODELS_DIR) or not os.listdir(MODELS_DIR):
        print(f"[!] Der Ordner {MODELS_DIR} ist leer oder existiert nicht. Bitte erst trainieren.")
        sys.exit(1)
        
    print("[i] Verfügbare Basis-Modelle in /models/:")
    available_models = [f for f in os.listdir(MODELS_DIR) if f.endswith(".pth") or f.endswith(".pt")]
    for m in available_models:
        print(f"  - {m}")
        
    model_name = input("\nBitte gib den Namen des Modells ein, das du finetunen möchtest (z.B. unet_floorplan_local.pth): ")
    
    model_path = os.path.join(MODELS_DIR, model_name)
    if not os.path.exists(model_path):
        print(f"[!] Modell '{model_path}' nicht gefunden.")
        sys.exit(1)
        
    # 2. Hardware setup
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == 'cuda':
        print(f"[OK] CUDA aktiv! Grafikkarte erkannt: {torch.cuda.get_device_name(0)}")
        torch.backends.cudnn.benchmark = True
    else:
        print("[!] WARNUNG: Keine NVIDIA GPU / CUDA gefunden.")
        
    # 3. Datensatz laden (Wir importieren LocalFloorplanDataset aus train_unet)
    try:
        train_dataset = LocalFloorplanDataset(FINETUNE_SKETCHES, FINETUNE_MASKS, image_size=512)
        if len(train_dataset) == 0:
            print(f"[!] Kein Datensatz gefunden in {FINETUNE_SKETCHES}. Bitte Skizzen und Masken dort ablegen.")
            sys.exit(1)
    except FileNotFoundError as e:
        print(e)
        print("\n[!] FEHLER: Bitte stelle sicher, dass die Ordnerstruktur existiert:")
        print("    └── finetune_training_data/")
        print("        ├── train/      (Enthält z.B. handskizze1.png)")
        print("        └── masks/      (Enthält exakt dieselben Dateinamen für die Masken)")
        sys.exit(1)
        
    num_workers = min(4, os.cpu_count() or 2)
    BATCH_SIZE = 8  
    
    train_loader = DataLoader(
        train_dataset, 
        batch_size=BATCH_SIZE, 
        shuffle=True, 
        num_workers=num_workers,
        pin_memory=True if device.type == 'cuda' else False
    )
    
    # 4. Modell laden
    print(f"\n[+] Lade Basis-Modell: {model_name}")
    unet_model = create_unet_model()
    # Gewichte laden (Pretrained CubiCasa Modell)
    unet_model.load_state_dict(torch.load(model_path, map_location=device, weights_only=True))
        
    # 5. Fine-Tuning starten
    # Weniger Epochen (z.B. 5-10) und kleine Lernrate (1e-4) sind für Finetuning optimal
    epochs = 10 
    lr = 0.0001 
    
    trained_model, loss_history = finetune_unet(unet_model, train_loader, device, num_epochs=epochs, learning_rate=lr)
    
    # 6. Modell speichern
    save_name = model_name.replace(".pth", "_finetuned.pth").replace(".pt", "_finetuned.pth")
    model_save_path = os.path.join(MODELS_DIR, save_name)
    torch.save(trained_model.state_dict(), model_save_path)
    
    print("-" * 60)
    print(f"[OK] FINETUNING ERFOLGREICH BEENDET!")
    print(f"[OK] Gefinetunetes Modell gespeichert unter: {model_save_path}")
    print("=" * 60)
