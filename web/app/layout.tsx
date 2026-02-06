import "./globals.css";

export const metadata = {
  title: "메랜큐",
  description: "메이플랜드 파티 도우미"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <div className="container">{children}</div>
      </body>
    </html>
  );
}
