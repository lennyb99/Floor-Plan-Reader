import cv2
import torch
import numpy as np
from typing import Tuple, Union, Optional
import os

# Import the model architecture
from product.segmentation.model import create_unet_model

def load_segmentation_model(model_path: str, device: Optional[torch.device] = None) -> torch.nn.Module:
    """Lädt das PyTorch-Modell in den Speicher (ohne Festplatten-I/O während der Vorhersage)."""
    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Modell nicht gefunden: {model_path}")
        
    model = create_unet_model()
    model.load_state_dict(torch.load(model_path, map_location=device, weights_only=True))
    model.to(device)
    model.eval()
    
    return model

def predict_mask(model: torch.nn.Module, image: Union[str, np.ndarray], device: Optional[torch.device] = None, return_probs: bool = False) -> Union[np.ndarray, Tuple[np.ndarray, np.ndarray]]:
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
            img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            
    original_size = img.shape[:2]
    
    # Preprocessing
    img_resized = cv2.resize(img, (512, 512))
    img_tensor = torch.from_numpy(img_resized).unsqueeze(0).unsqueeze(0).float() / 255.0
    img_tensor = img_tensor.to(device)
    
    # Prediction
    with torch.no_grad():
        output = model(img_tensor)
        probs = torch.sigmoid(output)
        
        probs_np = probs.cpu().squeeze().numpy()
        binary_mask = (probs > 0.5).float().cpu().squeeze().numpy()
        
    # Postprocessing (Werte skalieren und auf Originalgröße resizen)
    visible_mask = (binary_mask * 255).astype(np.uint8)
    visible_mask = cv2.resize(visible_mask, (original_size[1], original_size[0]), interpolation=cv2.INTER_NEAREST)
    
    if return_probs:
        prob_image = (probs_np * 255).astype(np.uint8)
        prob_image = cv2.resize(prob_image, (original_size[1], original_size[0]), interpolation=cv2.INTER_LINEAR)
        return visible_mask, prob_image
        
    return visible_mask
