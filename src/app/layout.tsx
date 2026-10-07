import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "CodeForge — IA autonome de développement logiciel",
  description:
    "Décrivez un logiciel en langage naturel. CodeForge conçoit l'architecture, écrit chaque fichier réellement, valide, corrige et vous livre un ZIP prêt à l'emploi. Aucun template, aucune clé API.",
};

export const viewport: Viewport = {
  themeColor: "#060609",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        <div className="ambient" aria-hidden />
        {children}
      </body>
    </html>
  );
}
