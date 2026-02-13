import struct

def create_ico():
    # Minimal 1x1 pixel transparent ICO header + data
    # Header: Reserved (2), Type (2=ICON), Count (2)
    header = struct.pack('<HHH', 0, 1, 1)
    
    # Directory Entry: Width, Height, Colors, Reserved, Planes, BPP, Size, Offset
    # 16x16, 0 colors (>=8bpp), 0 reserved, 1 plane, 32 bpp, size of PNG/BMP, offset
    # Let's just write a raw BMP payload for simplicity or a very simple PNG signature if supported.
    # Actually, simplest is a 1x1 BMP.
    
    # BMP Header (40 bytes) + Pixel Data (4 bytes)
    bmp_size = 40 + 4 
    offset = 6 + 16 
    entry = struct.pack('<BBBBHHII', 16, 16, 0, 0, 1, 32, bmp_size, offset)
    
    # DIB Header
    dib_header = struct.pack('<IiiHHIIIIII', 40, 1, 2, 1, 32, 0, 4, 0, 0, 0, 0)
    
    # Pixel (BGRA) - Red
    pixel = b'\x00\x00\xFF\xFF'
    
    with open('src-tauri/icons/icon.ico', 'wb') as f:
        f.write(header + entry + dib_header + pixel)
        print("Created minimal icon.ico")

if __name__ == '__main__':
    create_ico()
