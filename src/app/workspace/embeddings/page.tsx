import { redirect } from "next/navigation";

export default function EmbeddingsPage() {
  redirect("/workspace?panel=embeddings");
}
