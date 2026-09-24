import Image from "next/image";
import type { ReactNode } from "react";

export function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="shell">
      <header className="brand">
        <Image src="/internal.svg" alt="" width={38} height={38} unoptimized />
        <span>IT部</span>
      </header>
      <h1>{title}</h1>
      <section className="card">{children}</section>
      <footer>
        <a href="https://tmedit.org/internal/terms" target="_blank" rel="noopener noreferrer">利用規約</a>
        <span>・</span>
        <a href="https://tmedit.org/internal/privacy" target="_blank" rel="noopener noreferrer">プライバシーポリシー</a>
      </footer>
    </main>
  );
}
