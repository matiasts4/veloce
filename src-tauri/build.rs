fn main() {
    println!("cargo:rerun-if-changed=../python/audio_engine.py");
    tauri_build::build()
}
