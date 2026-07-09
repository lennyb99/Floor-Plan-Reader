import segmentation_models_pytorch as smp

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
