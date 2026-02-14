import setup_whisper

if __name__ == "__main__":
    print("Preparing FULL build (Binaries + Model)...")
    setup_whisper.setup_whisper_cpp()
    setup_whisper.setup_model()
    print("Full build preparation complete.")
