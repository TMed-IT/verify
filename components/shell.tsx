import Image from "next/image";
import type { ReactNode } from "react";
import siteConfig from "@/src/config.mjs";

export function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="shell">
      <header className="brand">
        <Image src={siteConfig.brand.logoPath} alt="" width={38} height={38} unoptimized />
        <span>{siteConfig.brand.organizationName}</span>
      </header>
      <h1>{title}</h1>
      <section className="card">{children}</section>
      <footer>
        <a href={siteConfig.publicInfo.termsUrl} target="_blank" rel="noopener noreferrer">利用規約</a>
        <span>・</span>
        <a href={siteConfig.publicInfo.privacyPolicyUrl} target="_blank" rel="noopener noreferrer">プライバシーポリシー</a>
      </footer>
    </main>
  );
}
