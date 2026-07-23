"""Curated local weight profiles used by the prototype."""

YOLO_PROFILES = {
    "yolo_cc_1.pt": {
        "label": "CubiCasa",
        "recommended": False,
        },
    "yolo_cc_Handdrawn_1.pt": {
        "label": "CubiCasa Handdrawn Augementation",
        "recommended": False,
    },
    "yolo_cc_Sketch_1.pt": {
        "label": "CubiCasa Sketch Augmentation",
        "recommended": False,
    },
    "yolo_real_1.pt": {
        "label": "Handdrawn Floorplans",
        "recommended": False,
    },
    "yolo_real_Aug_1.pt": {
        "label": "Handdrawn Floorplans Augmented",
        "recommended": False,
    },
    "yolo_real_Aug_2.pt": {
        "label": "Handdrawn Floorplans Augmented more epochs",
        "recommended": False,
    },
    "yolo_real_Aug_3.pt": {
        "label": "Big boy",
        "recommended": True,
    },
    "yolo_eeaao.pt": {
        "label": "eeaao",
        "recommended": True,
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
        "label": "Sketch U-Net · baseline",
        "recommended": False,
        "threshold": 0.56,
        "low_threshold": 0.50,
        "invert_output": False,
    },
    "unet_real_finetuned_v1.pt": {
        "label": "Real sketch U-Net · production",
        "recommended": True,
        # Fine-tuned on leakage-free real_training / real_training_aug splits.
        # Thresholds were selected on validation only, before the one-time
        # immutable real_test holdout evaluation.
        "threshold": 0.50,
        "low_threshold": 0.42,
        "invert_output": False,
        "dice": 0.82810,
        "iou": 0.70662,
        "boundary_f1": 0.96990,
        "topology_score": 0.61665,
        "sha256": "2ced00dd57bf0be877c85fd5d3dad8b5e8c20be47ec38d542fe9494191ff437c",
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

DEFAULT_YOLO = "yolo_real_Aug_3.pt"
DEFAULT_UNET = "unet_real_finetuned_v1.pt"


def public_profiles(profiles: dict) -> list[dict]:
    return [{"file": filename, **profile} for filename, profile in profiles.items()]
