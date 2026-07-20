import cv2
import torch
import numpy as np
from typing import Tuple, Union, Optional
import os

# Import the model architecture
from product.segmentation.model import create_unet_model

MODEL_STRIDE = 32

def load_segmentation_model(model_path: str, device: Optional[torch.device] = None) -> torch.nn.Module:
    """Lädt das PyTorch-Modell in den Speicher (ohne Festplatten-I/O während der Vorhersage)."""
    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Modell nicht gefunden: {model_path}")
        
    model = create_unet_model(encoder_weights=None)
    model.load_state_dict(torch.load(model_path, map_location=device, weights_only=True))
    model.to(device)
    model.eval()
    
    return model

def _hysteresis_mask(probabilities: np.ndarray, threshold: float, low_threshold: float) -> np.ndarray:
    """Keep weak predictions only when connected to a confident wall region."""
    strong = probabilities >= threshold
    weak = (probabilities >= low_threshold).astype(np.uint8)
    count, labels = cv2.connectedComponents(weak, connectivity=8)
    keep = np.zeros_like(weak)
    for label in range(1, count):
        component = labels == label
        if np.any(strong & component):
            keep[component] = 1
    return keep


def predict_mask(
    model: torch.nn.Module,
    image: Union[str, np.ndarray],
    device: Optional[torch.device] = None,
    return_probs: bool = False,
    threshold: float = 0.5,
    low_threshold: float = 0.30,
    invert_output: bool = False,
) -> Union[np.ndarray, Tuple[np.ndarray, np.ndarray]]:
    """
    Führt die Modellvorhersage auf einem Bild komplett im Arbeitsspeicher aus.
    
    Args:
        model: Das geladene PyTorch-Modell (via load_segmentation_model)
        image: Entweder ein Numpy-Array (Bild) oder ein Dateipfad
        device: CPU oder CUDA (optional)
        return_probs: Falls True, werden sowohl die binäre Maske als auch die Wahrscheinlichkeits-Map zurückgegeben.
        
    Returns:
        binary_mask (als Numpy-Array im Originalformat, skaliert auf 0 und 255)
        oder (binary_mask, prob_map), falls return_probs=True
    """
    if device is None:
        device = next(model.parameters()).device
        
    # Bild laden, falls ein Pfad übergeben wurde
    if isinstance(image, str):
        if not os.path.exists(image):
            raise FileNotFoundError(f"Bild nicht gefunden: {image}")
        img = cv2.imread(image, cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise ValueError(f"Bild konnte nicht geladen werden: {image}")
    else:
        img = image
        if len(img.shape) == 3:
            # Arrays in the product pipeline originate from PIL/preprocessing
            # and are RGB, not OpenCV BGR.
            img = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
            
    threshold = float(np.clip(threshold, 0.05, 0.95))
    low_threshold = float(np.clip(low_threshold, 0.01, threshold))

    # ResNet encoders need dimensions divisible by 32. Inputs are padded only
    # when a non-standard size is requested; the public 512 px size is native.
    height, width = img.shape[:2]
    padded_height = int(np.ceil(height / MODEL_STRIDE) * MODEL_STRIDE)
    padded_width = int(np.ceil(width / MODEL_STRIDE) * MODEL_STRIDE)
    pad_top = (padded_height - height) // 2
    pad_bottom = padded_height - height - pad_top
    pad_left = (padded_width - width) // 2
    pad_right = padded_width - width - pad_left
    img_padded = cv2.copyMakeBorder(
        img, pad_top, pad_bottom, pad_left, pad_right,
        cv2.BORDER_CONSTANT, value=255,
    )
    img_tensor = torch.from_numpy(img_padded).unsqueeze(0).unsqueeze(0).float() / 255.0
    img_tensor = img_tensor.to(device)
    
    # Prediction
    with torch.no_grad():
        output = model(img_tensor)
        probs = torch.sigmoid(output)
        
        probs_np = probs.cpu().squeeze().numpy()

    probs_np = probs_np[pad_top:pad_top + height, pad_left:pad_left + width]
    if invert_output:
        probs_np = 1.0 - probs_np
    binary_mask = _hysteresis_mask(probs_np, threshold, low_threshold)
        
    # Postprocessing (Werte skalieren und auf Originalgröße resizen)
    visible_mask = (binary_mask * 255).astype(np.uint8)
    
    if return_probs:
        prob_image = (probs_np * 255).astype(np.uint8)
        return visible_mask, prob_image
        
    return visible_mask
