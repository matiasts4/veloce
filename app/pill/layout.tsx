import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Veloce Status",
};

export default function PillLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="bg-transparent">
      <body
        className="bg-transparent overflow-hidden"
        style={{ background: "transparent", margin: 0, padding: 0 }}
      >
        {children}
      </body>
    </html>
  );
}
