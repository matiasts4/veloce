import sys
import os
print("CUDA_VISIBLE_DEVICES:", os.environ.get("CUDA_VISIBLE_DEVICES"))

try:
    import torch
    print("Torch version:", torch.__version__)
    print("Cuda version compiled with Torch:", torch.version.cuda)
    print("Is CUDA available:", torch.cuda.is_available())
except Exception as e:
    print("Error:", e)
