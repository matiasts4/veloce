# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

datas = []
binaries = []
hiddenimports = ['speechbrain', 'torchaudio', 'scipy']
tmp_ret = collect_all('speechbrain')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('faster_whisper')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
# tmp_ret = collect_all('torch')
# datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('ctranslate2')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

# Attempt to collect nvidia CUDA libs if present


# Attempt to collect nvidia CUDA libs if present
try:
    tmp_ret = collect_all('nvidia')
    datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
except Exception:
    pass

# Filter huge nvidia libs that might not be needed for inference
# cusparse (sparse matrices), nvrtc (runtime compilation), profiler
# We keep cublas, cudnn, cufft, curand, cusolver (maybe needed)
excludes = ['cusparse', 'nvrtc', 'profiler', 'tools', 'compiler']
binaries = [x for x in binaries if not any(s in x[0].lower() for s in excludes)]




a = Analysis(
    ['python\\audio_engine.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='audio-engine',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

# Filter out large DLLs that are likely not needed or covered by other means
# torch_cuda: huge, we use ctranslate2 for inference
# cusparse: sparse matrices not used
# cudnn_engines: precompiled engines, might be regenerated or not needed
# nvrtc: runtime compilation
# torch_cuda: huge, but needed for detection if we use torch.cuda.is_available()
# Re-enabled for decoupled installer (size ok)
large_excludes = [
    # 'torch_cuda', # Re-enabled
    'cusparse', 
    'cudnn_engines', 
    'nvrtc',
    'jit',
    'cufft', # faster-whisper might not need FFT if using ctranslate2? Actually it processes audio so maybe spectrogram? 
             # torchaudio uses it. But maybe cpu version is enough? 
             # Let's keep cufft for safety unless we are desperate.
]

# We must filter a.binaries before COLLECT
# But COLLECT takes a.binaries. We can filter it there.
full_binaries = a.binaries
# Filter tuples (name, path, type)
filtered_binaries = [x for x in full_binaries if not any(exc in x[0].lower() for exc in large_excludes)]

coll = COLLECT(
    exe,
    filtered_binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='audio-engine',
)
