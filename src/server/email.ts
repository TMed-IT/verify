import template from "./templates/verification.html";
import siteConfig from "../config.mjs";

function escapeHtml(value: string): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

export function verificationEmail(link: string, expiresInSeconds: number): Pick<EmailMessageBuilder, "subject" | "text" | "html"> {
  const minutes = expiresInSeconds / 60;
  const safeLink = escapeHtml(link);
  const organizationName = siteConfig.brand.organizationName;
  return {
    subject: `${organizationName} 学生ステータスの確認`,
    text: `学生ステータスの確認\n\n大学から付与されたメールアドレスの受信確認を行います。次のリンクを、認証を始めたブラウザで開いてください。\n\n${link}\n\n有効期間は送信から${minutes}分間、一度だけ使用できます。リンクを開いた後、画面の確認ボタンを押すと認証が完了します。\n\n心当たりがなければ、このメールを破棄してください。`,
    html: template.replace(/\{\{(LINK|MINUTES|ORGANIZATION_NAME)\}\}/g, (_match, key: "LINK" | "MINUTES" | "ORGANIZATION_NAME") => {
      if (key === "LINK") return safeLink;
      if (key === "MINUTES") return String(minutes);
      return escapeHtml(organizationName);
    }),
  };
}
