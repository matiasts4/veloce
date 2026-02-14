import setup_whisper
import os

if __name__ == "__main__":
    print("Preparing LIGHT build (Binaries ONLY)...")
    
    # Ensure binaries are present
    setup_whisper.setup_whisper_cpp()
    
    # Remove large model if present
    model_path = setup_whisper.MODELS_DIR / "ggml-large-v3-turbo.bin"
    if model_path.exists():
        print(f"Removing {model_path} for LIGHT build...")
        os.remove(model_path)
    else:
        print("Model file not present, skipping removal.")
        
    print("Light build preparation complete.")
