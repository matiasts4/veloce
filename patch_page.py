import re

with open('app/page.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace miniIsListening with a more complex status logic
# Actually, we can just replace the whole showMiniWidget block

old_block = r'''        ) : showMiniWidget \? \(
          <motion\.div
            key="mini-widget"
            initial=\{\{ opacity: 0, scale: 0\.8 \}\}
            animate=\{\{ opacity: 1, scale: 1 \}\}
            exit=\{\{ opacity: 0, scale: 0\.8 \}\}
            className="absolute left-0 top-0 z-50 flex h-full w-full items-center justify-center p-3"
          >
            <div
              className=\{`group relative flex h-11 w-fit min-w-\[170px\] cursor-grab items-center rounded-full border border-border/80 bg-card px-5 shadow-xl transition-all duration-500 active:cursor-grabbing \$\{miniIsListening \? "border-primary/40 shadow-\[0_0_15px_rgba\(37,99,235,0\.15\)\] ring-1 ring-primary/20" : "hover:border-border"\} `\}
              data-tauri-drag-region
            >
              \{\/\* Main Content Area \*\/\}
              <div
                data-tauri-drag-region
                className="flex items-center gap-3\.5 py-1"
                onDoubleClick=\{handleRestoreFromMiniWidget\}
              >
                <div className="flex items-center gap-\[1\.8px\] pointer-events-none">
                  \{\[0, 1, 2, 3, 4, 5\]\.map\(\(i\) => \(
                    <motion\.span
                      key=\{i\}
                      className=\{`w-\[2\.5px\] rounded-full \$\{miniIsListening \? "bg-primary" : "bg-muted-foreground/30"\}`\}
                      animate=\{miniIsListening \? \{
                        height: \[5, 14, 7, 16, 5\],
                      \} : \{
                        height: 7
                      \}\}
                      transition=\{\{
                        duration: 1\.2 \+ \(i \* 0\.15\),
                        repeat: Infinity,
                        delay: i \* 0\.1,
                        ease: "easeInOut",
                      \}\}
                    />
                  \)\)\}
                </div>
                <span className=\{`pointer-events-none font-mono text-\[10px\] font-medium uppercase tracking-widest transition-colors \$\{miniIsListening \? "text-primary/90" : "text-muted-foreground"\}`\}>
                  \{showMiniDoneTick \? t\("mini\.ready"\) : t\("mini\.recorder"\)\}
                </span>
              </div>

              \{\/\* Close Button in the literal corner \*\/\}
              <button
                onClick=\{async \(e\) => \{
                  e\.stopPropagation\(\);
                  try \{
                    const \{ getCurrentWindow \} = await import\("@tauri-apps/api/window"\);
                    await getCurrentWindow\(\)\.close\(\);
                  \} catch \(error\) \{
                    console\.error\("Failed to close app", error\);
                  \}
                \}\}
                className="absolute right-0 top-0 flex h-5 w-5 scale-0 items-center justify-center rounded-full bg-muted/20 text-muted-foreground opacity-0 shadow-sm transition-all duration-300 group-hover:scale-100 group-hover:opacity-100 hover:bg-destructive hover:text-white"
                aria-label=\{t\("mini\.close_mini_widget"\)\}
              >
                <X className="h-3 w-3 stroke-\[2\.5\]" />
              </button>
            </div>
          </motion\.div>
        \) : \('''

new_block = '''        ) : showMiniWidget ? (
          <motion.div
            key="mini-widget"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            className="absolute left-0 top-0 z-50 flex h-full w-full items-center justify-center p-3"
          >
            <div
              className={`group relative flex h-11 w-fit min-w-[170px] cursor-grab items-center rounded-full border border-border/80 bg-card px-5 shadow-xl transition-all duration-500 active:cursor-grabbing overflow-hidden ${
                status === "listening" 
                  ? "border-primary/40 shadow-[0_0_15px_rgba(37,99,235,0.15)] ring-1 ring-primary/20" 
                  : (status === "transcribing" || status === "processing")
                  ? "border-amber-500/40 shadow-[0_0_15px_rgba(245,158,11,0.15)] ring-1 ring-amber-500/20"
                  : "hover:border-border"
              }`}
              data-tauri-drag-region
            >
              {/* Main Content Area */}
              <div
                data-tauri-drag-region
                className="flex items-center gap-3.5 py-1 z-10 w-full"
                onDoubleClick={handleRestoreFromMiniWidget}
              >
                <div className="flex items-center gap-[1.8px] pointer-events-none">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <motion.span
                      key={i}
                      className={`w-[2.5px] rounded-full transition-colors duration-500 ${
                        status === "listening" ? "bg-primary" : 
                        (status === "transcribing" || status === "processing") ? "bg-amber-500/80" : 
                        "bg-muted-foreground/30"
                      }`}
                      animate={status === "listening" ? {
                        height: [5, 14, 7, 16, 5],
                      } : (status === "transcribing" || status === "processing") ? {
                        height: [7, 10, 7],
                      } : {
                        height: 7
                      }}
                      transition={{
                        duration: (status === "transcribing" || status === "processing") ? 1.0 : 1.2 + (i * 0.15),
                        repeat: Infinity,
                        delay: i * 0.1,
                        ease: "easeInOut",
                      }}
                    />
                  ))}
                </div>
                <span className={`pointer-events-none font-mono text-[10px] font-medium uppercase tracking-widest transition-colors duration-500 ${
                  status === "listening" ? "text-primary/90" : 
                  (status === "transcribing" || status === "processing") ? "text-amber-500/90" : 
                  "text-muted-foreground"
                }`}>
                  {showMiniDoneTick 
                    ? t("mini.ready") 
                    : (status === "transcribing" || status === "processing") 
                      ? t(`status.${status}`) 
                      : t("mini.recorder")}
                </span>
              </div>

              {/* VU Meter integrated at the bottom */}
              <div className={`absolute bottom-0 left-0 right-0 z-0 transition-opacity duration-300 ${status === "listening" ? "opacity-100" : "opacity-0"}`}>
                <VUMeter className="w-full h-[3px] bg-transparent" barClassName="h-full bg-primary/80 origin-left transition-transform duration-[50ms] ease-out" />
              </div>

              {/* Close Button in the literal corner */}
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    const { getCurrentWindow } = await import("@tauri-apps/api/window");
                    await getCurrentWindow().close();
                  } catch (error) {
                    console.error("Failed to close app", error);
                  }
                }}
                className="absolute right-0 top-0 z-20 flex h-5 w-5 scale-0 items-center justify-center rounded-full bg-muted/20 text-muted-foreground opacity-0 shadow-sm transition-all duration-300 group-hover:scale-100 group-hover:opacity-100 hover:bg-destructive hover:text-white"
                aria-label={t("mini.close_mini_widget")}
              >
                <X className="h-3 w-3 stroke-[2.5]" />
              </button>
            </div>
          </motion.div>
        ) : ('''

content = re.sub(old_block, new_block, content)

with open('app/page.tsx', 'w', encoding='utf-8') as f:
    f.write(content)
