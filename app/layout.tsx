import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "学生ステータスを確認 | IT部",
  icons: { icon: "/internal.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>
        <div className="glow glow-a" aria-hidden="true" />
        <div className="glow glow-b" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
