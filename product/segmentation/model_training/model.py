import os
import cv2
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
import segmentation_models_pytorch as smp
from tqdm.auto import tqdm
import matplotlib.pyplot as plt

# 1. Dataset-Klasse für lokale Daten
class LocalFloorplanDataset(Dataset):
    def __init__(self, sketches_dir, masks_dir, image_size=512):
        self.sketches_dir = sketches_dir
        self.masks_dir = masks_dir
        self.image_size = image_size

        if not os.path.exists(sketches_dir):
            raise FileNotFoundError(f"Sketches-Verzeichnis nicht gefunden: {sketches_dir}")
        if not os.path.exists(masks_dir):
            raise FileNotFoundError(f"Masks-Verzeichnis nicht gefunden: {masks_dir}")

        sketch_files = set(os.listdir(sketches_dir))
        mask_files = set(os.listdir(masks_dir))
        
        # Erlaubte Bildendungen filtern
        valid_extensions = ('.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff')
        common_files = [f for f in sketch_files.intersection(mask_files) if f.lower().endswith(valid_extensions)]
        self.filenames = sorted(common_files)

        print(f"[OK] Datensatz initialisiert mit {len(self.filenames)} Bild-Masken-Paaren.")

    def __len__(self):
        return len(self.filenames)

    def __getitem__(self, index):
        fname = self.filenames[index]
        sketch_path = os.path.join(self.sketches_dir, fname)
        mask_path = os.path.join(self.masks_dir, fname)

        # Bilder im Graustufenmodus laden (in_channels=1)
        sketch = cv2.imread(sketch_path, cv2.IMREAD_GRAYSCALE)
        mask = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)

        if sketch is None or mask is None:
            print(f"[!] Warnung: Konnte {fname} nicht laden. Nutze Ersatz-Index.")
            return self.__getitem__((index + 1) % len(self))

        # Skalierung auf die Zielgröße
        sketch = cv2.resize(sketch, (self.image_size, self.image_size))
        mask = cv2.resize(mask, (self.image_size, self.image_size))

        # Konvertierung in PyTorch Tensoren [Kanal, Höhe, Breite] und Normalisierung auf [0, 1]
        sketch = torch.from_numpy(sketch).unsqueeze(0).float() / 255.0
        # FIX: Die Masken-Bilder haben bereits nur die Werte 0 und 1. Durch /255.0 wurden sie zu 0.0039.
        # Mit > 0 stellen wir sicher, dass jeder Wert über 0 zu 1.0 wird (funktioniert auch bei 255er Masken).
        mask = (torch.from_numpy(mask).unsqueeze(0).float() > 0).float()

        return sketch, mask

# 2. Modell-Erstellung
def create_unet_model():
    """
    Initialisiert das U-Net Modell mit einem ResNet34 Encoder.
    Vortrainierte Gewichte helfen auch bei reinen S/W-Strukturen, Linien schneller zu lernen.
    """
    model = smp.Unet(
        encoder_name="resnet34",
        encoder_weights="imagenet",
        in_channels=1,         # 1 Kanal für Graustufenskizzen
        classes=1,             # 1 Klasse für die Wände (Binärmaske)
        activation=None        # Nutzen BCEWithLogitsLoss, daher keine Aktivierung am Ende
    )
    return model

# 3. Trainings-Funktion mit integrierter Metrik-Speicherung
def train_unet(model, dataloader, device, num_epochs=10, learning_rate=0.001):
    model = model.to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=learning_rate)
    
    # Kombinierter Loss aus BCE (Pixel-Genauigkeit) und Dice (balanciert dünne Linien/Wände besser aus)
    bce_loss_fn = smp.losses.SoftBCEWithLogitsLoss()
    dice_loss_fn = smp.losses.DiceLoss(mode='binary')

    epoch_losses = []
    
    print(f"\n[+] Starte lokales Training auf Gerät: {device}")
    print(f"[+] Bilder im Datensatz: {len(dataloader.dataset)} | Epochen geplant: {num_epochs}\n")

    for epoch in range(num_epochs):
        model.train()
        running_loss = 0.0
        
        # Live-Anzeige des Fortschritts pro Batch via tqdm
        pbar = tqdm(dataloader, desc=f"Epoche {epoch+1}/{num_epochs}", leave=True)
        for sketches, masks in pbar:
            # non_blocking=True beschleunigt den VRAM-Transfer in Kombination mit pin_memory
            sketches = sketches.to(device, non_blocking=True)
            masks = masks.to(device, non_blocking=True)

            # Forward-Pass
            predictions = model(sketches)
            loss = bce_loss_fn(predictions, masks) + dice_loss_fn(predictions, masks)

            # Backward-Pass & Optimierung
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            running_loss += loss.item()
            # Live-Update des aktuellen Batch-Verlusts in der Konsole
            pbar.set_postfix({"loss_this_batch": f"{loss.item():.4f}"})

        # Durchschnittlichen Loss der Epoche berechnen
        avg_loss = running_loss / len(dataloader)
        epoch_losses.append(avg_loss)
        print(f"-> Epoche {epoch+1} beendet. Durchschnittlicher Loss: {avg_loss:.4f}\n")

    # Nach dem Training: Diagramm erstellen und lokal speichern
    plt.figure(figsize=(10, 5))
    plt.plot(range(1, num_epochs + 1), epoch_losses, marker='o', linestyle='-', color='#1f77b4', label='Total Loss (BCE + Dice)')
    plt.title('Trainingsverlust-Verlauf (Loss Curve)')
    plt.xlabel('Epoche')
    plt.ylabel('Verlustwert')
    plt.grid(True, linestyle='--', alpha=0.6)
    plt.legend()
    
    plot_path = "loss_history_plot.png"
    plt.savefig(plot_path, dpi=150, bbox_inches='tight')
    plt.close()
    print(f"[OK] Verlustkurve wurde live ausgewertet und als '{plot_path}' gespeichert.")

    return model, epoch_losses

# 4. Hauptprogramm (Ausführungsschutz für lokales Multiprocessing)
if __name__ == "__main__":
    # Pfade dynamisch relativ zum Skript-Speicherort ermitteln
    BASE_DIR = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else os.getcwd()
    TRAIN_SKETCHES = os.path.join(BASE_DIR, "training_data", "train")
    TRAIN_MASKS = os.path.join(BASE_DIR, "training_data", "masks")

    print("="*60)
    print(" Grundriss-KI: U-Net Wandsegmentierung (Lokales Training)")
    print("="*60)
    print(f"Pfade werden überprüft:\n -> Skizzen: {TRAIN_SKETCHES}\n -> Masken:  {TRAIN_MASKS}\n")

    # Hardware-Optimierung für deine RTX 4070 Super
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == 'cuda':
        print(f"[OK] CUDA aktiv! Grafikkarte erkannt: {torch.cuda.get_device_name(0)}")
        # Aktiviert den cuDNN Autotuner für maximale Performance bei gleichbleibender Input-Größe
        torch.backends.cudnn.benchmark = True
    else:
        print("[!] WARNUNG: Keine NVIDIA GPU / CUDA gefunden. Training läuft langsam auf der CPU.")

    try:
        # Datensatz laden
        train_dataset = LocalFloorplanDataset(TRAIN_SKETCHES, TRAIN_MASKS, image_size=512)
        
        # Optimierter DataLoader für lokale GPUs
        # Auf Windows/Linux nutzt 'num_workers' mehrere CPU-Kerne parallel zum Laden/Resizen der Bilder
        num_workers = min(4, os.cpu_count() or 2)
        
        # Deine RTX 4070 Super (12GB VRAM) schafft bei 512x512 (Graustufen) locker eine Batch Size von 16 oder 32.
        # Erhöhe bei Bedarf von 8 auf 16, um die GPU noch besser auszulasten!
        BATCH_SIZE = 16 
        
        train_loader = DataLoader(
            train_dataset, 
            batch_size=BATCH_SIZE, 
            shuffle=True, 
            num_workers=num_workers,
            pin_memory=True if device.type == 'cuda' else False  # Schnellere Speicherübergabe an die GPU
        )

        # Modell initialisieren
        unet_model = create_unet_model()
        
        # Training starten (passe num_epochs nach Bedarf an, z.B. 20-50 für gute Konvergenz)
        epochs = 5
        trained_model, loss_history = train_unet(unet_model, train_loader, device, num_epochs=epochs, learning_rate=0.001)

        # Gewichte und Modell abspeichern
        models_dir = os.path.join(BASE_DIR, "models")
        os.makedirs(models_dir, exist_ok=True)
        
        model_save_path = os.path.join(models_dir, "unet_floorplan_local.pth")
        torch.save(trained_model.state_dict(), model_save_path)
        
        print("-" * 60)
        print(f"[OK] TRAINING ERFOLGREICH BEENDET!")
        print(f"[OK] Modell-Gewichte lokal gespeichert unter: {model_save_path}")
        print("=" * 60)

    except FileNotFoundError as e:
        print(e)
        print("\n[!] FEHLER: Bitte stelle sicher, dass deine Ordnerstruktur genau so aussieht:")
        print("    ├── model.py")
        print("    └── training_data/")
        print("        ├── train/      (Enthält z.B. bild1.png, bild2.png)")
        print("        └── masks/      (Enthält exakt dieselben Dateinamen für die Masken)")