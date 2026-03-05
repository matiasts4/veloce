import shutil
import os
import sys

def zip_directory(source_dir, output_filename):
    if not os.path.exists(source_dir):
        print(f"Source directory not found: {source_dir}")
        sys.exit(1)

    # Remove existing zip if it exists
    if os.path.exists(output_filename):
        try:
            os.remove(output_filename)
        except OSError as e:
            print(f"Error removing existing zip: {e}")
            sys.exit(1)

    print(f"Zipping {source_dir} to {output_filename}...")
    try:
        # shutil.make_archive adds the extension automatically, so we remove it from output_filename if present
        base_name = os.path.splitext(output_filename)[0]
        shutil.make_archive(base_name, 'zip', source_dir)
        print("Zip created successfully.")
    except Exception as e:
        print(f"Error creating zip: {e}")
        sys.exit(1)

if __name__ == "__main__":
    source = r"dist\audio-engine"
    destination = r"dist\audio-engine.zip"
    zip_directory(source, destination)
