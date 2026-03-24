import os
from huggingface_hub import snapshot_download

def main():
    print("Iniciando descarga manual del modelo large-v3-turbo (Formato CTranslate2 para faster-whisper)...")
    repo_id = "deepdml/faster-whisper-large-v3-turbo"
    print(f"Repositorio: {repo_id}")
    
    try:
        path = snapshot_download(
            repo_id=repo_id,
            repo_type="model",
            local_files_only=False
        )
        print(f"\n¡Descarga completada!\nEl modelo se ha guardado en la caché local: {path}")
    except Exception as e:
        print(f"\nError al descargar: {e}")

if __name__ == "__main__":
    main()
