import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "SiteSentry", template: "%s · SiteSentry" },
  description: "Technical SEO audits that end in verified fixes: evidence for every finding, acceptance criteria for every task, and a re-check that proves the result.",
};

// Applies the theme the user picked (ThemeToggle) before first paint, so a dark choice never flashes light. Without a
// stored choice the CSS follows prefers-color-scheme.
const THEME_SCRIPT = `try{var t=localStorage.getItem("ss-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-theme is set by THEME_SCRIPT before hydration.
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
