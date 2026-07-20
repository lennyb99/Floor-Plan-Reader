"""Curated local weight profiles used by the prototype."""

YOLO_PROFILES = {
    "yolo_cc_Handdrawn1.pt": {
        "label": "Hand-drawn",
        "recommended": False,
        "mAP50": 0.99348,
        "mAP50_95": 0.79001,
    },
    "yolo_cc_Sketch1.pt": {
        "label": "Clean sketch",
        "recommended": False,
        "mAP50": 0.78918,
        "mAP50_95": 0.55287,
    },
    "yolo_real1.pt": {
        "label": "Photo / ink sketch · recommended",
        "recommended": True,
        "mAP50": 0.69906,
        "mAP50_95": 0.50101,
    },
    "yolo_cc_1.pt": {
        "label": "CubiCasa legacy",
        "recommended": False,
    },
}

UNET_PROFILES = {
    "finalunet.pt": {
        "label": "Final U-Net · clean plans",
        "recommended": False,
        "threshold": 0.50,
        "low_threshold": 0.28,
        "invert_output": False,
    },
    "unet_FullCubicasa.pt": {
        "label": "Full CubiCasa",
        "recommended": False,
        "threshold": 0.50,
        "low_threshold": 0.30,
        "invert_output": False,
    },
    "unet_final_onlymax.pt": {
        "label": "Sketch U-Net · recommended",
        "recommended": True,
        # Calibrated on clean + augmented photographed sketches from
        # real_training / real_training_aug (grouped validation sample).
        "threshold": 0.56,
        "low_threshold": 0.50,
        "invert_output": False,
    },
    "uNetWeights.pt": {
        "label": "Legacy (inverted output)",
        "recommended": False,
        "threshold": 0.50,
        "low_threshold": 0.30,
        "invert_output": True,
    },
    "uNetRealDataWeights.pt": {
        "label": "Real-data experimental",
        "recommended": False,
        "threshold": 0.50,
        "low_threshold": 0.30,
        "invert_output": False,
    },
}

DEFAULT_YOLO = "yolo_real1.pt"
DEFAULT_UNET = "unet_final_onlymax.pt"


def public_profiles(profiles: dict) -> list[dict]:
    return [{"file": filename, **profile} for filename, profile in profiles.items()]
