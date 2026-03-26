import type { Metadata } from "next";
import DownloadContent from "./DownloadContent";

export const metadata: Metadata = { title: "Download" };

export default function DownloadPage() {
  return <DownloadContent />;
}
