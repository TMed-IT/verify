import { HomeButton } from "@/components/home-button";
import { Shell } from "@/components/shell";

export default function NotFound() {
  return (
    <Shell title="ページが見つかりません">
      <p className="subtle">URLをご確認いただくか、トップからやり直してください。</p>
      <HomeButton />
    </Shell>
  );
}
