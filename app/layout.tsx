import type { Metadata } from "next";
import siteConfig from "@/src/config.mjs";
import "./globals.css";

export const metadata: Metadata = {
  title: `学生ステータスを確認 | ${siteConfig.brand.organizationName}`,
  icons: { icon: siteConfig.brand.logoPath },
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
