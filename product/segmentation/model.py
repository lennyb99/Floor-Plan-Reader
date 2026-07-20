from typing import Optional

import segmentation_models_pytorch as smp

def create_unet_model(encoder_weights: Optional[str] = None):
    """
    Initialisiert das U-Net Modell mit einem ResNet34 Encoder.
    Vortrainierte Gewichte helfen auch bei reinen S/W-Strukturen, Linien schneller zu lernen.
    """
    model = smp.Unet(
        encoder_name="resnet34",
        # Inference loads a complete local state_dict immediately afterwards.
        # Downloading ImageNet weights here made the prototype fail offline.
        # Training callers can still explicitly pass ``"imagenet"``.
        encoder_weights=encoder_weights,
        in_channels=1,         # 1 Kanal für Graustufenskizzen
        classes=1,             # 1 Klasse für die Wände (Binärmaske)
        activation=None        # Nutzen BCEWithLogitsLoss, daher keine Aktivierung am Ende
    )
    return model
